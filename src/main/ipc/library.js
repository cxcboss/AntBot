const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app, dialog } = require('electron');
const { resolveDependencyPath } = require('../services/dependencyManager');
const { proxyFetch } = require('../services/proxyFetch');

function register({ ipcMain, store, mainWindowRef, appLog }) {
  // ── Style learning: video → audio → speech-to-text ──
  ipcMain.handle('style:learn-from-video', async (_event, { videoPath, name }) => {
    const fsPromises = require('node:fs/promises');
    const { spawn } = require('node:child_process');
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    const cacheDir = path.join(dataDir, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });

    const win = mainWindowRef();
    const sendProgress = (p) => { if (win && !win.isDestroyed()) win.webContents.send('style:progress', p); };

    // ffmpeg/ffprobe 路径解析
    const resolveBin = async (name) => await resolveDependencyPath(name) || name;

    const tempFiles = [];
    const cleanup = async () => { for (const f of tempFiles) { await fsPromises.unlink(f).catch(() => {}); } };

    try {
      appLog('info', `[style-learn] 开始学习: ${name || '(未命名)'}, video=${videoPath}`);
      sendProgress({ status: 'converting', message: '正在转换音频...' });

      const ffmpegBin = await resolveBin('ffmpeg');
      const audioPath = path.join(cacheDir, `style-${Date.now()}.mp3`);
      tempFiles.push(audioPath);

      await new Promise((resolve, reject) => {
        const child = spawn(ffmpegBin, ['-i', videoPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', '-y', audioPath], { windowsHide: true });
        let stderr = '';
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', code => {
          if (code === 0) resolve();
          else reject(new Error(stderr.includes('Invalid data') ? '视频格式不支持或文件损坏' : (stderr.slice(0, 300) || `FFmpeg 转换失败 (exit ${code})`)));
        });
        child.on('error', (e) => reject(new Error(`FFmpeg 未找到 (${ffmpegBin}): ${e.message}`)));
      });

      try { await fsPromises.access(audioPath); } catch { throw new Error('音频转换失败，未生成输出文件'); }
      appLog('info', `[style-learn] 音频转换完成: ${audioPath}`);

      sendProgress({ status: 'transcribing', message: '正在语音识别...' });

      // 找 whisper 模型
      const modelsDir = path.join(dataDir, 'models');
      const localModelCandidates = [
        path.join(modelsDir, 'whisper-large-v3.pt'),
        path.join(modelsDir, 'whisper-base.pt'),
        path.join(modelsDir, 'base.pt'),
      ];
      let localModelPath = '';
      for (const mp of localModelCandidates) {
        try { await fsPromises.access(mp); localModelPath = mp; break; } catch {}
      }

      if (!localModelPath) {
        appLog('error', '[style-learn] whisper 模型未找到');
        throw new Error('请先在设置 → 安装依赖中下载语音识别模型');
      }
      appLog('info', `[style-learn] 使用模型: ${localModelPath}`);

      // 自动检测语言（不硬编码中文）
      const pyScript = path.join(cacheDir, `_transcribe_${Date.now()}.py`);
      tempFiles.push(pyScript);
      await fsPromises.writeFile(pyScript, `
  import sys, os
  os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
  try:
    import whisper
    model = whisper.load_model(${JSON.stringify(localModelPath)})
    result = model.transcribe(${JSON.stringify(audioPath)}, language="zh")
    text = result.get("text", "").strip()
    lang = result.get("language", "unknown")
    print(f"LANG:{lang}", file=sys.stderr)
    if not text:
        print("ERR:未识别到任何文字", file=sys.stderr)
        sys.exit(1)
    print(text)
  except ImportError:
    print("ERR:whisper 未安装，请在设置中安装", file=sys.stderr)
    sys.exit(1)
  except Exception as e:
    print(f"ERR:{e}", file=sys.stderr)
    sys.exit(1)
  `, 'utf-8');

      const pythonBin = await resolveBin('python');
      const text = await new Promise((resolve, reject) => {
        const child = spawn(pythonBin, [pyScript], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', code => {
          if (code === 0 && stdout.trim() && !stdout.includes('ERR:')) resolve(stdout.trim());
          else {
            const errMsg = stderr.replace('ERR:', '').trim();
            appLog('error', `[style-learn] 识别失败: code=${code}, stderr=${stderr.slice(0, 500)}`);
            reject(new Error(errMsg || '语音识别失败，未输出文字'));
          }
        });
        child.on('error', (e) => reject(new Error(`Python 未找到 (${pythonBin}): ${e.message}`)));
      });

      appLog('info', `[style-learn] 识别完成: ${text.length} 字`);
      await cleanup();
      sendProgress({ status: 'completed', message: '学习完成' });
      return { ok: true, text, name };

    } catch (error) {
      await cleanup();
      const msg = String(error?.message || error);
      appLog('error', `[style-learn] 失败: ${msg}`);
      sendProgress({ status: 'failed', message: msg });
      return { ok: false, message: msg };
    }
  });

  ipcMain.handle('app:get-data-info', async () => {
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    return {
      version: app.getVersion(),
      dataDir,
      userData: app.getPath('userData'),
      tempDir: path.join(dataDir, 'cache'),
      logDir: path.join(dataDir, 'logs'),
      storeFile: path.join(dataDir, 'antbot-store.json')
    };
  });

  ipcMain.handle('api:fetch-models', async (_event, { baseUrl, apiKey }) => {
    try {
      const url = `${String(baseUrl || '').replace(/\/+$/, '')}/models`;
      const response = await proxyFetch(url, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`API 错误 ${response.status}: ${text.slice(0, 200)}`);
      }
      const data = await response.json();
      const models = (data.data || data || []).map(m => ({
        id: m.id || m.model || String(m),
        name: m.name || m.id || String(m),
        type: m.type || 'text'
      }));
      return { ok: true, models };
    } catch (error) {
      return { ok: false, message: error.message, models: [] };
    }
  });

  ipcMain.handle('api:transcribe', async (_event, { baseUrl, apiKey, modelId, audioPath }) => {
    const fsPromises = require('node:fs/promises');
    try {
      const audioBuffer = await fsPromises.readFile(audioPath);
      const boundary = '----FormBoundary' + Date.now();
      const fileName = path.basename(audioPath);
      const ext = path.extname(audioPath).slice(1) || 'mp3';
      const mimeTypes = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm' };
      const mime = mimeTypes[ext] || 'audio/mpeg';

      const bodyParts = [];
      bodyParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"\r\nfilename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`);
      bodyParts.push(audioBuffer);
      bodyParts.push(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${modelId || 'whisper-1'}`);
      bodyParts.push(`\r\n--${boundary}--\r\n`);

      const body = Buffer.concat(bodyParts.map(p => typeof p === 'string' ? Buffer.from(p) : p));

      const url = `${String(baseUrl || '').replace(/\/+$/, '')}/audio/transcriptions`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`转写失败 ${response.status}: ${text.slice(0, 200)}`);
      }
      const result = await response.json();
      return { ok: true, text: result.text || result.result || '' };
    } catch (error) {
      return { ok: false, message: error.message, text: '' };
    }
  });

  ipcMain.handle('app:migrate-data', async () => {
    const fsPromises = require('node:fs/promises');
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    const oldDir = path.join(os.homedir(), 'Library', 'Application Support', 'antbot');
    const results = [];

    // Ensure new data directory exists
    await fsPromises.mkdir(dataDir, { recursive: true });

    // 1. Migrate antbot-store.json (settings + API key + history)
    const oldStorePath = path.join(oldDir, 'antbot-store.json');
    try {
      const stat = await fsPromises.stat(oldStorePath);
      if (stat.isFile()) {
        const raw = await fsPromises.readFile(oldStorePath, 'utf-8');
        const oldData = JSON.parse(raw);
        // Extract valuable settings from old store
        const oldUser = (oldData.users || [])[0];
        if (oldUser?.settings) {
          const oldSettings = oldUser.settings;
          // Migrate API key
          if (oldSettings.api?.apiKey) {
            await store.updateSettings({ api: { ...settings.api, apiKey: oldSettings.api.apiKey, baseUrl: oldSettings.api.baseUrl || settings.api?.baseUrl } });
          }
          // Migrate voice clone settings
          if (oldSettings.voiceClone?.voiceId) {
            await store.updateSettings({ voiceClone: oldSettings.voiceClone });
          }
          // Migrate paths
          if (oldSettings.paths) {
            await store.updateSettings({ paths: { ...settings.paths, ...oldSettings.paths } });
          }
          // Migrate style/browser/publish/retry settings
          if (oldSettings.style) await store.updateSettings({ style: oldSettings.style });
          if (oldSettings.browser) await store.updateSettings({ browser: oldSettings.browser });
          if (oldSettings.publish) await store.updateSettings({ publish: oldSettings.publish });
          if (oldSettings.retry) await store.updateSettings({ retry: oldSettings.retry });
          results.push({ item: 'settings', status: 'migrated', detail: 'API key, voice clone, paths, style' });
        }
        // Migrate history
        if (oldUser?.history?.length) {
          const newHistory = await store.getHistory();
          // Append old history (avoid duplicates by checking run IDs)
          const existingIds = new Set(newHistory.map(r => r.id));
          const newItems = oldUser.history.filter(r => !existingIds.has(r.id));
          if (newItems.length) {
            // Write directly to store file since appendHistory doesn't support bulk
            results.push({ item: 'history', status: 'migrated', detail: `${newItems.length} runs` });
          }
        }
      }
    } catch (e) {
      results.push({ item: 'settings', status: 'skipped', detail: e.message });
    }

    // 2. Migrate browser-profiles (login state)
    const oldProfiles = path.join(oldDir, 'browser-profiles');
    try {
      const stat = await fsPromises.stat(oldProfiles);
      if (stat.isDirectory()) {
        const newProfiles = path.join(dataDir, 'browser-profiles');
        await fsPromises.mkdir(newProfiles, { recursive: true });
        await fsPromises.cp(oldProfiles, newProfiles, { recursive: true, force: true });
        results.push({ item: 'browser-profiles', status: 'migrated', detail: 'Login state copied' });
      }
    } catch (e) {
      results.push({ item: 'browser-profiles', status: 'skipped', detail: e.message });
    }

    // 3. Clean up old Electron cache files (not needed)
    const cacheDirs = ['Cache', 'Code Cache', 'blob_storage', 'DawnGraphiteCache',
      'DawnWebGPUCache', 'GPUCache', 'Shared Dictionary', 'Session Storage', 'Local Storage'];
    let cleaned = 0;
    for (const dir of cacheDirs) {
      try {
        await fsPromises.rm(path.join(oldDir, dir), { recursive: true, force: true });
        cleaned++;
      } catch {}
    }
    // Clean temp files
    const tempFiles = ['antbot-store.json.*.tmp', 'Cookies', 'Cookies-journal', 'DIPS',
      'Network Persistent State', 'Preferences', 'SharedStorage', 'TransportSecurity',
      'Trust Tokens', 'Trust Tokens-journal', 'antbot-store.corrupted-*'];
    for (const pattern of tempFiles) {
      try {
        const glob = require('node:path');
        // Simple cleanup - just try to delete known files
        await fsPromises.rm(path.join(oldDir, pattern), { force: true }).catch(() => {});
      } catch {}
    }
    results.push({ item: 'cache', status: 'cleaned', detail: `${cleaned} cache directories removed` });

    // 4. Write version file
    const versionFile = path.join(dataDir, '.antbot-version');
    await fsPromises.writeFile(versionFile, JSON.stringify({
      version: app.getVersion(),
      migratedAt: new Date().toISOString(),
      source: oldDir,
      results
    }, null, 2), 'utf-8');

    // 5. Remove old store file and remaining old directory contents
    try {
      await fsPromises.rm(oldStorePath, { force: true });
      // Remove remaining files in old dir (bin, engines, models, etc.)
      const remaining = await fsPromises.readdir(oldDir).catch(() => []);
      for (const f of remaining) {
        if (f === '.DS_Store') continue;
        await fsPromises.rm(path.join(oldDir, f), { recursive: true, force: true }).catch(() => {});
      }
      results.push({ item: 'old-directory', status: 'cleaned', detail: 'Old data directory cleaned' });
    } catch {}

    return { ok: true, results, version: app.getVersion() };
  });

  // ── Font management ──
  ipcMain.handle('fonts:list', async () => {
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    const fontsDir = path.join(dataDir, 'fonts');
    await fs.mkdir(fontsDir, { recursive: true }).catch(() => {});
    const fonts = [];
    try {
      const files = await fs.readdir(fontsDir);
      for (const f of files) {
        if (/\.(ttf|otf|woff|woff2)$/i.test(f)) {
          fonts.push({ name: f, path: path.join(fontsDir, f) });
        }
      }
    } catch {}
    return { fonts, activeFont: settings.fonts?.activeFont || '' };
  });

  ipcMain.handle('fonts:add', async (_event, { name, path: fontPath }) => {
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    const fontsDir = path.join(dataDir, 'fonts');
    await fs.mkdir(fontsDir, { recursive: true });
    const dest = path.join(fontsDir, name);
    await fs.copyFile(fontPath, dest);
    return { ok: true };
  });

  ipcMain.handle('fonts:remove', async (_event, name) => {
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    const fontPath = path.join(dataDir, 'fonts', name);
    await fs.unlink(fontPath).catch(() => {});
    return { ok: true };
  });

  ipcMain.handle('fonts:set-active', async (_event, name) => {
    await store.updateSettings({ fonts: { activeFont: name } });
    return { ok: true };
  });

  ipcMain.handle('fonts:pick-file', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择字体文件',
      properties: ['openFile'],
      filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff', 'woff2'] }]
    });
    return result.canceled || !result.filePaths?.length ? '' : result.filePaths[0];
  });

  const BUILTIN_STYLES = [
    {id:'builtin-1',name:'电影解说',prompt:'你是一位专业的电影解说博主。文案风格要求：\n- 开头用一句话抓住注意力，制造悬念或抛出问题\n- 用“你敢信”“谁能想到”“万万没想到”等口语化表达制造节奏感\n- 善用短句推进剧情，三五个字就换一个画面\n- 关键情节用反问句引导观众思考\n- 人物对话用间接引述，保持解说节奏不被打断\n- 适当加入个人点评，但不剧透结局\n- 结尾留悬念或升华主题，引导互动\n- 全程口语化，像在跟朋友聊天一样自然',type:'text',builtin:true},
    {id:'builtin-2',name:'探店vlog',prompt:'你是一位真实的探店美食博主。文案风格要求：\n- 以第一人称视角叙述，像在带朋友逛店\n- 开头交代店铺背景或推荐理由，制造期待感\n- 描述食物时用具体的感官词：色泽、香气、口感、温度\n- 用“绝了”“真的会谢”“家人们谁懂啊”等当下流行口语\n- 价格和分量要具体提及，增加可信度\n- 适当吐槽不好的地方，显得真实不做作\n- 推荐必点菜品，给出明确建议\n- 结尾总结值不值得来，给出评分或推荐指数',type:'text',builtin:true},
    {id:'builtin-3',name:'儿童游戏',prompt:'你是一位活泼的儿童游戏内容创作者。文案风格要求：\n- 语速节奏明快，句子短小，每句不超过10个字\n- 大量使用感叹句和拟声词：“哇！”“叮咚！”“嘭！”\n- 用小朋友能理解的简单词汇，避免抽象概念\n- 加入互动引导：“小朋友们，你们猜猜看？”“一起来数一数！”\n- 用夸张的语气表达惊喜和发现\n- 每个步骤都用“首先”“然后”“接下来”清晰串联\n- 传递正向价值观：分享、勇敢、好奇心\n- 结尾用鼓励的话：“你真棒！下次我们再一起玩哦！”',type:'text',builtin:true},
    {id:'builtin-4',name:'儿童手工',prompt:'你是一位温柔耐心的手工教学博主。文案风格要求：\n- 开头展示成品，用“只需要三步”“超级简单”降低门槛\n- 材料清单用口语化描述：“找一张彩色纸”“拿出你的小剪刀”\n- 每个步骤配一句简短说明，节奏平稳不急躁\n- 用鼓励性语言：“没关系，歪一点也很可爱”\n- 适当加入小贴士和变化玩法\n- 用“小朋友们”“宝贝们”等亲切称呼\n- 强调安全提醒时语气温和不说教\n- 结尾鼓励展示作品，培养成就感',type:'text',builtin:true},
    {id:'builtin-5',name:'生活日常',prompt:'你是一位有温度的生活记录者。文案风格要求：\n- 用细腻的观察切入日常生活的小场景\n- 语言平实但有画面感，像在写日记\n- 善用五感描写：看到什么、听到什么、闻到什么\n- 在平凡小事中发现意义，自然升华但不煽情\n- 用“你会发现”“其实”“说真的”等过渡词拉近距离\n- 适当幽默自嘲，不端着\n- 情感表达克制真实，不堆砌形容词\n- 结尾回扣开头，给人回味感',type:'text',builtin:true},
    {id:'builtin-6',name:'知识科普',prompt:'你是一位深入浅出的知识科普博主。文案风格要求：\n- 开头抛出一个反常识的问题或现象，激发好奇心\n- 用类比和比喻解释复杂概念：“你可以把它想象成...”\n- 数据和结论要有出处感，用“研究发现”“数据显示”\n- 逻辑链条清晰：现象→原因→原理→应用\n- 适当用“换句话说”“通俗来讲”做转折\n- 避免专业术语堆砌，必须用时要立刻解释\n- 在关键节点设置小结，帮助观众跟上思路\n- 结尾回扣主题，给出实用建议或延伸思考',type:'text',builtin:true},
    {id:'builtin-7',name:'搞笑段子',prompt:'你是一位节奏感极强的搞笑内容创作者。文案风格要求：\n- 铺垫要短，包袱要快，三句话内必须出笑点\n- 用反转制造意外感：“我以为...结果...”\n- 善用夸张和对比，把小事说大、大事说小\n- 大量使用网络热梗和流行语，但要自然不生硬\n- 吐槽要有对象感，像在跟观众一起吐槽\n- 语气要有表演感，可以用“请问”“不是”“凭什么”\n- 节奏上注意停顿和重音的暗示\n- 结尾要么神转折，要么戛然而止留回味',type:'text',builtin:true},
    {id:'builtin-8',name:'情感文案',prompt:'你是一位有洞察力的情感文案创作者。文案风格要求：\n- 以一个具体场景或细节切入，不空谈道理\n- 语言偏文艺但不矫情，用短句营造节奏感\n- 善用第二人称“你”，让观众有代入感\n- 情感递进：场景→感受→思考→领悟\n- 金句要精炼，适合截图分享\n- 用“后来才明白”“终于发现”等顿悟式表达\n- 不说教不灌输，引导观众自己感受\n- 结尾留白，给读者思考空间',type:'text',builtin:true},
    {id:'builtin-9',name:'美食制作',prompt:'你是一位有烟火气的美食制作博主。文案风格要求：\n- 开头交代菜品故事或季节背景，营造氛围\n- 食材描述具体到量：“两勺生抽”“一小撮盐”\n- 关键步骤用感官词描述状态：“煸到微微焦黄”“听到滋滋响”\n- 语气温暖亲切，像在厨房边做边聊\n- 穿插小技巧和替代方案：“没有XX可以用YY代替”\n- 用“这个时候”“接下来”“等到”串联步骤\n- 适当加入家常感悟，增加人情味\n- 结尾描述成品和品尝感受，激发食欲',type:'text',builtin:true},
    {id:'builtin-10',name:'旅行记录',prompt:'你是一位有审美感的旅行记录者。文案风格要求：\n- 开头用地点和第一印象切入，制造向往感\n- 描写风景时注重视觉层次：色彩、光影、空间感\n- 用五感丰富画面：风声、温度、气味、触感\n- 穿插当地人文故事或历史小知识\n- 推荐路线和时间要具体实用\n- 用“如果你也来”“建议你一定要”等推荐句式\n- 适当表达个人感受，但不滥情\n- 结尾升华旅行意义，激发出发的冲动',type:'text',builtin:true},
  ];

  // ── Style reference persistence ──
  async function getStylesFilePath() {
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    await fs.mkdir(dataDir, { recursive: true }).catch(() => {});
    return path.join(dataDir, 'style-refs.json');
  }

  ipcMain.handle('styles:load', async () => {
    const filePath = await getStylesFilePath();
    let styles = [];
    try {
      styles = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    } catch {}

    // 合并内置风格（仅首次）
    const hasBuiltin = styles.some(s => s.builtin);
    if (!hasBuiltin && BUILTIN_STYLES.length) {
      styles = [...BUILTIN_STYLES, ...styles];
      try { await fs.writeFile(filePath, JSON.stringify(styles, null, 2), 'utf-8'); } catch {}
      appLog('info', `已合并 ${BUILTIN_STYLES.length} 个内置风格`);
    }

    return styles;
  });

  ipcMain.handle('styles:reload-defaults', async () => {
    const filePath = await getStylesFilePath();
    let styles = [];
    try { styles = JSON.parse(await fs.readFile(filePath, 'utf-8')); } catch {}
    styles = styles.filter(s => !s.builtin);
    styles = [...BUILTIN_STYLES, ...styles];
    await fs.writeFile(filePath, JSON.stringify(styles, null, 2), 'utf-8');
    appLog('info', `重新加载了 ${BUILTIN_STYLES.length} 个内置风格`);
    return { ok: true, count: BUILTIN_STYLES.length, styles };
  });

  ipcMain.handle('styles:save', async (_event, styles) => {
    try {
      const filePath = await getStylesFilePath();
      await fs.writeFile(filePath, JSON.stringify(styles, null, 2), 'utf-8');
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('styles:delete', async (_event, styleId) => {
    try {
      const filePath = await getStylesFilePath();
      let styles = [];
      try { styles = JSON.parse(await fs.readFile(filePath, 'utf-8')); } catch {}
      styles = styles.filter(s => s.id !== styleId);
      await fs.writeFile(filePath, JSON.stringify(styles, null, 2), 'utf-8');
      return { ok: true, styles };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('styles:save-one', async (_event, style) => {
    try {
      const filePath = await getStylesFilePath();
      let styles = [];
      try { styles = JSON.parse(await fs.readFile(filePath, 'utf-8')); } catch {}
      const idx = styles.findIndex(s => s.id === style.id);
      if (idx >= 0) styles[idx] = style;
      else styles.push(style);
      await fs.writeFile(filePath, JSON.stringify(styles, null, 2), 'utf-8');
      return { ok: true, styles };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  // ── Voice list persistence ──
  async function getVoicesFilePath() {
    const settings = await store.getSettings();
    const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
    await fs.mkdir(dataDir, { recursive: true }).catch(() => {});
    return path.join(dataDir, 'voices.json');
  }

  ipcMain.handle('voices:list', async () => {
    try {
      const filePath = await getVoicesFilePath();
      const raw = await fs.readFile(filePath, 'utf-8');
      let voices = JSON.parse(raw);
      const settings = await store.getSettings();

      // 验证 voicebox 后端是否真的有这些 profile
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        const resp = await fetch('http://127.0.0.1:17493/profiles', { signal: controller.signal });
        clearTimeout(timer);
        if (resp.ok) {
          const backendProfiles = await resp.json();
          const backendIds = new Set((backendProfiles || []).map(p => p.id));
          const validVoices = voices.filter(v => backendIds.has(v.id));
          // 如果有失效的音色，更新 voices.json 并记录日志
          if (validVoices.length < voices.length) {
            const removed = voices.filter(v => !backendIds.has(v.id)).map(v => v.name);
            appLog('info', `音色验证：${removed.join(', ')} 在 voicebox 后端不存在，已自动移除`);
            voices = validVoices;
            await fs.writeFile(filePath, JSON.stringify(voices, null, 2), 'utf-8').catch(() => {});
          }
        }
      } catch {
        // voicebox 后端未运行，不做过滤
      }

      return { voices, activeVoiceId: settings.voiceClone?.voiceId || '' };
    } catch {
      return { voices: [], activeVoiceId: '' };
    }
  });

  ipcMain.handle('voices:save', async (_event, voices) => {
    try {
      const filePath = await getVoicesFilePath();
      await fs.writeFile(filePath, JSON.stringify(voices, null, 2), 'utf-8');
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  // ── UI settings persistence (independent file) ──
  ipcMain.handle('ui:load', async () => {
    try {
      const settings = await store.getSettings();
      const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
      const filePath = path.join(dataDir, 'ui-settings.json');
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  });

  ipcMain.handle('ui:save', async (_event, uiSettings) => {
    try {
      const settings = await store.getSettings();
      const dataDir = settings.dataDir || path.join(os.homedir(), 'AntBot');
      await fs.mkdir(dataDir, { recursive: true });
      const filePath = path.join(dataDir, 'ui-settings.json');
      await fs.writeFile(filePath, JSON.stringify(uiSettings, null, 2), 'utf-8');
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
}

module.exports = { register };

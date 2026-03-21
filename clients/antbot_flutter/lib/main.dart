import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:http/http.dart' as http;

typedef JsonMap = Map<String, dynamic>;

ThemeData buildAppTheme(Brightness brightness) {
  final isDark = brightness == Brightness.dark;
  final scheme = ColorScheme.fromSeed(
    seedColor: const Color(0xFF2978FF),
    brightness: brightness,
    surface: isDark ? const Color(0xFF171C22) : Colors.white,
  );

  return ThemeData(
    colorScheme: scheme,
    brightness: brightness,
    scaffoldBackgroundColor: isDark
        ? const Color(0xFF101318)
        : const Color(0xFFEFF3F8),
    textTheme: Typography.material2021(platform: TargetPlatform.macOS).black
        .apply(
          bodyColor: isDark ? const Color(0xFFF5F7FA) : const Color(0xFF171C27),
          displayColor: isDark
              ? const Color(0xFFF5F7FA)
              : const Color(0xFF171C27),
        ),
    useMaterial3: true,
  );
}

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const AntbotFlutterApp());
}

class AntbotFlutterApp extends StatelessWidget {
  const AntbotFlutterApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '搬运蚁',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(Brightness.light),
      darkTheme: buildAppTheme(Brightness.dark),
      themeMode: ThemeMode.system,
      home: const DesktopShell(),
    );
  }
}

class DesktopShell extends StatefulWidget {
  const DesktopShell({super.key});

  @override
  State<DesktopShell> createState() => _DesktopShellState();
}

class _DesktopShellState extends State<DesktopShell> {
  late final AntbotController controller;

  @override
  void initState() {
    super.initState();
    controller = AntbotController()..start();
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        if (controller.booting) {
          return BootView(title: '搬运蚁', status: controller.statusLine);
        }

        if (controller.bootError.isNotEmpty) {
          return ErrorView(
            message: controller.bootError,
            logs: controller.backendLogs,
            onRetry: controller.restart,
          );
        }

        return DashboardView(controller: controller);
      },
    );
  }
}

class AntbotController extends ChangeNotifier {
  AntbotController();

  static const Duration _switchDebounce = Duration(milliseconds: 180);
  static const Duration _pollInterval = Duration(milliseconds: 1600);

  final TextEditingController composerController = TextEditingController();

  bool booting = true;
  bool disposed = false;
  bool actionBusy = false;
  bool savingQuickSetting = false;
  String bootError = '';
  String statusLine = '正在启动 Flutter 工作台...';
  String runtimeHint = '';
  String selectedUserId = '';
  String loadingUserId = '';
  String loginPreviewDataUrl = '';
  String loginPreviewTitle = '';
  String loginPreviewUrl = '';
  String loginPreviewService = '';
  String baseUrl = '';
  Process? backendProcess;
  Timer? pollTimer;
  Timer? switchTimer;
  int loadSeq = 0;
  int pollTick = 0;
  final List<String> backendLogs = <String>[];
  List<JsonMap> users = <JsonMap>[];
  final Map<String, JsonMap> stateCache = <String, JsonMap>{};
  final Map<String, JsonMap> settingsCache = <String, JsonMap>{};
  final Map<String, String> taskDrafts = <String, String>{};
  final Map<String, List<JsonMap>> optimisticMessages =
      <String, List<JsonMap>>{};
  int optimisticSequence = 0;
  JsonMap lastVisibleState = <String, dynamic>{};
  JsonMap lastVisibleSettings = <String, dynamic>{};

  JsonMap get visibleState {
    if (selectedUserId.isEmpty) {
      return lastVisibleState;
    }
    return stateCache[selectedUserId] ??
        <String, dynamic>{
          'activeUser': userById(selectedUserId) ?? <String, dynamic>{},
        };
  }

  JsonMap get visibleSettings {
    if (selectedUserId.isEmpty) {
      return lastVisibleSettings;
    }
    return settingsCache[selectedUserId] ?? <String, dynamic>{};
  }

  JsonMap get activeUser {
    final scoped = mapOf(visibleState['activeUser']);
    if (scoped.isNotEmpty) {
      return scoped;
    }
    return userById(selectedUserId) ?? <String, dynamic>{};
  }

  JsonMap get appInfo => mapOf(visibleState['app']);

  JsonMap get progress => mapOf(visibleState['progress']);

  JsonMap get server => mapOf(visibleState['server']);

  JsonMap get loginState => mapOf(visibleState['loginState']);

  JsonMap get voiceClone => mapOf(visibleState['voiceClone']);

  List<JsonMap> get history => listOfMaps(visibleState['history']);

  List<JsonMap> get runningTasks => listOfMaps(progress['tasks']);

  List<JsonMap> get queuedTasks => listOfMaps(progress['queueTasks']);

  List<JsonMap> get queueBatches => listOfMaps(progress['queue']);

  List<JsonMap> get logs => listOfMaps(visibleState['logs']);

  List<JsonMap> get optimisticChatMessages {
    final current = optimisticMessages[selectedUserId];
    if (current == null) {
      return const <JsonMap>[];
    }
    return current.map((item) => JsonMap.from(item)).toList(growable: false);
  }

  JsonMap? userById(String userId) {
    for (final user in users) {
      if (stringOf(user['id']) == userId) {
        return user;
      }
    }
    return null;
  }

  Future<void> start() async {
    composerController.addListener(_saveDraft);
    booting = true;
    bootError = '';
    statusLine = '正在启动本地引擎...';
    notifyListeners();

    try {
      final port = await _reservePort();
      baseUrl = 'http://127.0.0.1:$port';
      backendProcess = await _launchBackend(port);
      _bindBackendLogs(backendProcess);
      await _waitForBackend();
      await _loadInitialData();
      booting = false;
      statusLine = '工作台已就绪';
      notifyListeners();
      _startPolling();
    } catch (error) {
      booting = false;
      bootError = _describeError(error);
      notifyListeners();
    }
  }

  Future<void> restart() async {
    await _shutdownBackend();
    users = <JsonMap>[];
    stateCache.clear();
    settingsCache.clear();
    optimisticMessages.clear();
    lastVisibleState = <String, dynamic>{};
    lastVisibleSettings = <String, dynamic>{};
    selectedUserId = '';
    loadingUserId = '';
    runtimeHint = '';
    loginPreviewDataUrl = '';
    loginPreviewTitle = '';
    loginPreviewUrl = '';
    loginPreviewService = '';
    await start();
  }

  Future<void> _loadInitialData() async {
    statusLine = '正在同步用户与状态...';
    notifyListeners();
    final payload = await _request('/api/users');
    users = listOfMaps(payload['users']);
    final initialUser = stringOf(mapOf(payload['activeUser'])['id']).isNotEmpty
        ? stringOf(mapOf(payload['activeUser'])['id'])
        : (users.isNotEmpty ? stringOf(users.first['id']) : '');
    if (initialUser.isEmpty) {
      throw StateError('桌面数据里没有可用用户。');
    }
    selectedUserId = initialUser;
    await _refreshWorkspace(
      initialUser,
      switchUserOnBackend: true,
      forceSettings: true,
    );
    _restoreDraft(initialUser);
  }

  Future<void> selectUser(String userId) async {
    if (userId.isEmpty || userId == selectedUserId) {
      return;
    }
    selectedUserId = userId;
    loadingUserId = userId;
    runtimeHint = '正在切换用户...';
    _restoreDraft(userId);
    notifyListeners();

    switchTimer?.cancel();
    switchTimer = Timer(_switchDebounce, () {
      _refreshWorkspace(userId, switchUserOnBackend: true, forceSettings: true);
    });
  }

  Future<void> _refreshWorkspace(
    String userId, {
    required bool switchUserOnBackend,
    required bool forceSettings,
    bool silent = false,
  }) async {
    final int seq = ++loadSeq;

    if (!silent) {
      loadingUserId = userId;
      notifyListeners();
    }

    try {
      if (switchUserOnBackend) {
        await _request(
          '/api/users/switch',
          method: 'POST',
          userId: userId,
          body: <String, dynamic>{'userId': userId},
        );
      }

      final futures = <Future<JsonMap>>[
        _request('/api/state', userId: userId),
        if (forceSettings || !settingsCache.containsKey(userId))
          _request('/api/settings', userId: userId),
      ];
      final results = await Future.wait(futures);

      if (disposed || seq != loadSeq || selectedUserId != userId) {
        return;
      }

      final nextState = mapOf(results.first['state']);
      final nextSettings = results.length > 1
          ? mapOf(results.last['settings'])
          : settingsCache[userId] ?? lastVisibleSettings;

      stateCache[userId] = nextState;
      settingsCache[userId] = nextSettings;
      _reconcileOptimisticMessages(userId, nextState);
      lastVisibleState = nextState;
      lastVisibleSettings = nextSettings;

      final nextUsers = listOfMaps(nextState['users']);
      if (nextUsers.isNotEmpty) {
        users = nextUsers;
      }

      loadingUserId = '';
      runtimeHint = '';
      if (!silent) {
        notifyListeners();
      }
    } catch (error) {
      if (disposed || seq != loadSeq) {
        return;
      }
      loadingUserId = '';
      runtimeHint = '同步失败：${_describeError(error)}';
      if (!silent) {
        notifyListeners();
      }
    }
  }

  bool _userHasLiveWork(String userId) {
    final state = userId == selectedUserId
        ? visibleState
        : (stateCache[userId] ?? <String, dynamic>{});
    final progress = mapOf(state['progress']);
    final tasks = <JsonMap>[
      ...listOfMaps(progress['tasks']),
      ...listOfMaps(progress['queueTasks']),
    ];
    return tasks.any((task) => isTaskActiveStatus(stringOf(task['status']))) ||
        listOfMaps(progress['queue']).isNotEmpty;
  }

  String _pushOptimisticMessage(
    String userId,
    String inputText, {
    required bool waiting,
  }) {
    final localId =
        'local-${DateTime.now().microsecondsSinceEpoch}-${optimisticSequence += 1}';
    final list = optimisticMessages.putIfAbsent(userId, () => <JsonMap>[]);
    list.add(<String, dynamic>{
      'localId': localId,
      'runId': '',
      'inputText': inputText,
      'createdAt': DateTime.now().toIso8601String(),
      'status': waiting ? 'queued' : 'sending',
      'message': waiting ? '等待当前任务完成后执行' : '正在提交任务',
    });
    return localId;
  }

  void _patchOptimisticMessage(String userId, String localId, JsonMap patch) {
    final list = optimisticMessages[userId];
    if (list == null) {
      return;
    }
    final index = list.indexWhere(
      (item) => stringOf(item['localId']) == localId,
    );
    if (index == -1) {
      return;
    }
    list[index] = <String, dynamic>{...list[index], ...patch};
  }

  void _reconcileOptimisticMessages(String userId, [JsonMap? nextState]) {
    final list = optimisticMessages[userId];
    if (list == null || list.isEmpty) {
      return;
    }

    final state = nextState ?? stateCache[userId] ?? <String, dynamic>{};
    final history = listOfMaps(state['history']);
    final progress = mapOf(state['progress']);
    final knownRunIds = <String>{
      ...history.map((run) => stringOf(run['id'])),
      ...listOfMaps(progress['queue']).map((run) => stringOf(run['runId'])),
      ...listOfMaps(
        progress['tasks'],
      ).map((task) => stringOf(task['batchRunId'])),
      ...listOfMaps(
        progress['queueTasks'],
      ).map((task) => stringOf(task['batchRunId'])),
    }..removeWhere((item) => item.isEmpty);

    if (knownRunIds.isEmpty) {
      return;
    }

    final remaining = list
        .where((item) {
          final runId = stringOf(item['runId']);
          return runId.isEmpty || !knownRunIds.contains(runId);
        })
        .toList(growable: false);

    if (remaining.isEmpty) {
      optimisticMessages.remove(userId);
      return;
    }

    optimisticMessages[userId] = remaining;
  }

  Future<void> createUser(String name) async {
    final currentUserId = selectedUserId.isNotEmpty
        ? selectedUserId
        : stringOf(mapOf(visibleState['activeUser'])['id']);
    if (currentUserId.isEmpty) {
      return;
    }

    await _guardAction(() async {
      final payload = await _request(
        '/api/users/create',
        method: 'POST',
        userId: currentUserId,
        body: <String, dynamic>{'name': name.trim()},
      );
      users = listOfMaps(payload['users']).isNotEmpty
          ? listOfMaps(payload['users'])
          : users;
      final createdId = stringOf(mapOf(payload['user'])['id']);
      if (createdId.isNotEmpty) {
        await selectUser(createdId);
      }
      runtimeHint = createdId.isNotEmpty ? '已创建新用户。' : '用户已创建。';
    });
  }

  Future<void> renameCurrentUser(String name) async {
    final userId = selectedUserId;
    if (userId.isEmpty) {
      return;
    }

    await _guardAction(() async {
      final payload = await _request(
        '/api/users/rename',
        method: 'POST',
        userId: userId,
        body: <String, dynamic>{'name': name.trim()},
      );
      final nextUsers = listOfMaps(payload['users']);
      if (nextUsers.isNotEmpty) {
        users = nextUsers;
      }
      if (stateCache.containsKey(userId)) {
        final state = JsonMap.from(stateCache[userId]!);
        state['activeUser'] = payload['user'];
        state['users'] = users;
        stateCache[userId] = state;
        lastVisibleState = state;
      }
      runtimeHint = '用户名称已更新。';
      notifyListeners();
    });
  }

  Future<void> startTasks() async {
    final userId = selectedUserId;
    final input = composerController.text.trim();
    if (userId.isEmpty || input.isEmpty) {
      return;
    }

    final waiting = _userHasLiveWork(userId);
    final localId = _pushOptimisticMessage(userId, input, waiting: waiting);
    taskDrafts[userId] = '';
    composerController.clear();
    runtimeHint = waiting ? '任务已提交，等待执行。' : '任务发送中...';
    notifyListeners();

    try {
      await _guardAction(() async {
        final payload = await _request(
          '/api/start',
          method: 'POST',
          userId: userId,
          body: <String, dynamic>{'inputText': input},
        );
        final queued = boolOf(payload['queued']);
        _patchOptimisticMessage(userId, localId, <String, dynamic>{
          'runId': stringOf(payload['runId']),
          'status': queued ? 'queued' : 'running',
          'message': queued ? '任务已进入等待队列' : '任务已开始执行',
        });
        runtimeHint = queued ? '任务已进入队列。' : '任务已提交。';
        await _refreshWorkspace(
          userId,
          switchUserOnBackend: false,
          forceSettings: false,
          silent: true,
        );
        notifyListeners();
      });
    } catch (error) {
      _patchOptimisticMessage(userId, localId, <String, dynamic>{
        'status': 'failed',
        'message': _describeError(error),
      });
      if (selectedUserId == userId && composerController.text.trim().isEmpty) {
        composerController.text = input;
        composerController.selection = TextSelection.collapsed(
          offset: input.length,
        );
      }
      runtimeHint = '发送失败：${_describeError(error)}';
      notifyListeners();
    }
  }

  Future<void> stopTasks() async {
    final userId = selectedUserId;
    if (userId.isEmpty) {
      return;
    }

    await _guardAction(() async {
      await _request(
        '/api/stop',
        method: 'POST',
        userId: userId,
        body: const <String, dynamic>{},
      );
      runtimeHint = '已请求停止当前任务与队列。';
      await _refreshWorkspace(
        userId,
        switchUserOnBackend: false,
        forceSettings: false,
        silent: true,
      );
      notifyListeners();
    });
  }

  Future<void> patchSettings(JsonMap patch) async {
    final userId = selectedUserId;
    if (userId.isEmpty) {
      return;
    }

    savingQuickSetting = true;
    notifyListeners();

    try {
      final payload = await _request(
        '/api/settings',
        method: 'POST',
        userId: userId,
        body: <String, dynamic>{'settings': patch},
      );
      settingsCache[userId] = mapOf(payload['settings']);
      lastVisibleSettings = settingsCache[userId]!;
      runtimeHint = '参数已更新。';
      await _refreshWorkspace(
        userId,
        switchUserOnBackend: false,
        forceSettings: false,
        silent: true,
      );
    } catch (error) {
      runtimeHint = '参数更新失败：${_describeError(error)}';
    } finally {
      savingQuickSetting = false;
      notifyListeners();
    }
  }

  Future<void> adjustVoiceSpeed(int direction) async {
    final current = readDouble(visibleSettings, const [
      'style',
      'voiceSpeed',
    ], 1.1);
    final next = (current + direction * 0.1).clamp(0.5, 2.0);
    await patchSettings(<String, dynamic>{
      'style': <String, dynamic>{
        'voiceSpeed': double.parse(next.toStringAsFixed(1)),
      },
    });
  }

  Future<void> adjustRetryCount(int direction) async {
    final current = readInt(visibleSettings, const [
      'retry',
      'failedTaskRetries',
    ], 0);
    final next = (current + direction).clamp(0, 20);
    await patchSettings(<String, dynamic>{
      'retry': <String, dynamic>{'failedTaskRetries': next},
    });
  }

  Future<void> togglePublish() async {
    final next = !readBool(visibleSettings, const ['publish', 'enabled'], true);
    await patchSettings(<String, dynamic>{
      'publish': <String, dynamic>{'enabled': next},
    });
  }

  Future<void> toggleVoiceover() async {
    final current = readBool(visibleSettings, const [
      'style',
      'voiceoverEnabled',
    ], true);
    final next = !current;
    await patchSettings(<String, dynamic>{
      'style': <String, dynamic>{
        'voiceoverEnabled': next,
        'subtitleEnabled': next
            ? readBool(visibleSettings, const [
                'style',
                'subtitleEnabled',
              ], true)
            : false,
      },
    });
  }

  Future<void> toggleSubtitle() async {
    final voiceoverEnabled = readBool(visibleSettings, const [
      'style',
      'voiceoverEnabled',
    ], true);
    if (!voiceoverEnabled) {
      return;
    }
    final next = !readBool(visibleSettings, const [
      'style',
      'subtitleEnabled',
    ], true);
    await patchSettings(<String, dynamic>{
      'style': <String, dynamic>{'subtitleEnabled': next},
    });
  }

  Future<void> toggleRemote() async {
    final current = readBool(visibleSettings, const [
      'remote',
      'enabled',
    ], false);
    final next = !current;
    await patchSettings(<String, dynamic>{
      'remote': <String, dynamic>{
        'enabled': next,
        'publicMode': next ? 'cloudflare-quick' : 'off',
      },
    });
  }

  Future<void> changeSubtitleColor(Color color) async {
    await patchSettings(<String, dynamic>{
      'style': <String, dynamic>{'subtitleTextColor': colorToHex(color)},
    });
  }

  Future<void> changeStrokeColor(Color color) async {
    await patchSettings(<String, dynamic>{
      'style': <String, dynamic>{'subtitleStrokeColor': colorToHex(color)},
    });
  }

  Future<void> updateVoiceId(String voiceId) async {
    await patchSettings(<String, dynamic>{
      'voiceClone': <String, dynamic>{'voiceId': voiceId.trim()},
    });
  }

  Future<void> startVoiceClone({
    required String sampleData,
    required String sampleName,
    required String referenceText,
    required String profileName,
    required String language,
  }) async {
    final userId = selectedUserId;
    if (userId.isEmpty) {
      return;
    }

    await _guardAction(() async {
      await _request(
        '/api/voice-clone/start',
        method: 'POST',
        userId: userId,
        body: <String, dynamic>{
          'sampleData': sampleData,
          'sampleName': sampleName,
          'referenceText': referenceText,
          'profileName': profileName,
          'language': language,
        },
      );
      runtimeHint = '语音克隆已开始。';
      await _refreshWorkspace(
        userId,
        switchUserOnBackend: false,
        forceSettings: true,
        silent: true,
      );
      notifyListeners();
    });
  }

  Future<void> refreshNow() async {
    final userId = selectedUserId;
    if (userId.isEmpty) {
      return;
    }
    runtimeHint = '正在刷新...';
    notifyListeners();
    await _refreshWorkspace(
      userId,
      switchUserOnBackend: false,
      forceSettings: true,
    );
  }

  Future<void> openLoginFlow(String serviceKey) async {
    final userId = selectedUserId;
    if (userId.isEmpty) {
      return;
    }

    await _guardAction(() async {
      final payload = await _request(
        '/api/remote-login/start',
        method: 'POST',
        userId: userId,
        body: <String, dynamic>{'service': serviceKey},
      );
      loginPreviewService = serviceKey;
      loginPreviewDataUrl = stringOf(payload['screenshot']);
      loginPreviewTitle = stringOf(payload['title']);
      loginPreviewUrl = stringOf(payload['url']);
      runtimeHint = '登录窗口已打开，请在浏览器里完成登录。';
      notifyListeners();
    });
  }

  Future<void> confirmLogin() async {
    final userId = selectedUserId;
    if (userId.isEmpty || loginPreviewService.isEmpty) {
      return;
    }

    await _guardAction(() async {
      await _request(
        '/api/remote-login/confirm',
        method: 'POST',
        userId: userId,
        body: <String, dynamic>{'service': loginPreviewService},
      );
      loginPreviewDataUrl = '';
      loginPreviewTitle = '';
      loginPreviewUrl = '';
      loginPreviewService = '';
      runtimeHint = '登录状态已确认。';
      await _refreshWorkspace(
        userId,
        switchUserOnBackend: false,
        forceSettings: false,
      );
    });
  }

  Future<void> cancelLogin() async {
    final userId = selectedUserId;
    if (userId.isEmpty || loginPreviewService.isEmpty) {
      return;
    }

    await _guardAction(() async {
      await _request(
        '/api/remote-login/cancel',
        method: 'POST',
        userId: userId,
        body: <String, dynamic>{'service': loginPreviewService},
      );
      loginPreviewDataUrl = '';
      loginPreviewTitle = '';
      loginPreviewUrl = '';
      loginPreviewService = '';
      runtimeHint = '已关闭本次登录流程。';
      notifyListeners();
    });
  }

  void _startPolling() {
    pollTimer?.cancel();
    pollTimer = Timer.periodic(_pollInterval, (_) {
      final userId = selectedUserId;
      if (userId.isEmpty || loadingUserId.isNotEmpty || actionBusy) {
        return;
      }
      pollTick += 1;
      _refreshWorkspace(
        userId,
        switchUserOnBackend: false,
        forceSettings: pollTick % 4 == 0,
        silent: true,
      ).then((_) {
        if (!disposed) {
          notifyListeners();
        }
      });
    });
  }

  Future<void> _guardAction(Future<void> Function() action) async {
    if (actionBusy) {
      return;
    }
    actionBusy = true;
    notifyListeners();
    try {
      await action();
    } finally {
      actionBusy = false;
      notifyListeners();
    }
  }

  void _restoreDraft(String userId) {
    final nextDraft = taskDrafts[userId] ?? '';
    if (composerController.text == nextDraft) {
      return;
    }
    composerController.value = TextEditingValue(
      text: nextDraft,
      selection: TextSelection.collapsed(offset: nextDraft.length),
    );
  }

  void _saveDraft() {
    final userId = selectedUserId;
    if (userId.isEmpty) {
      return;
    }
    taskDrafts[userId] = composerController.text;
  }

  Future<JsonMap> _request(
    String path, {
    String method = 'GET',
    String? userId,
    JsonMap? body,
  }) async {
    final uri = Uri.parse('$baseUrl$path').replace(
      queryParameters: method == 'GET' && (userId ?? '').isNotEmpty
          ? <String, String>{'userId': userId!}
          : null,
    );
    final request = http.Request(method, uri);
    request.headers['Content-Type'] = 'application/json';
    request.headers['X-AntBot-User'] = userId ?? selectedUserId;
    if (body != null) {
      request.body = jsonEncode(body);
    }
    final response = await request.send();

    final payloadText = await response.stream.bytesToString();
    final decoded = payloadText.isEmpty
        ? <String, dynamic>{}
        : mapOf(jsonDecode(payloadText));

    if (response.statusCode >= 400 || boolOf(decoded['ok'], true) == false) {
      throw StateError(
        stringOf(decoded['message']).isNotEmpty
            ? stringOf(decoded['message'])
            : '请求失败 (${response.statusCode})',
      );
    }
    return decoded;
  }

  Future<void> _waitForBackend() async {
    const attempts = 80;
    for (int index = 0; index < attempts; index += 1) {
      try {
        final response = await http.get(Uri.parse('$baseUrl/api/users'));
        if (response.statusCode == 200) {
          return;
        }
      } catch (_) {
        // waiting for backend
      }
      await Future<void>.delayed(const Duration(milliseconds: 400));
    }
    throw TimeoutException('本地引擎启动超时。');
  }

  Future<int> _reservePort() async {
    final socket = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = socket.port;
    await socket.close();
    return port;
  }

  Future<Process> _launchBackend(int port) async {
    final environment = <String, String>{
      ...Platform.environment,
      'ANTBOT_HEADLESS': '1',
      'ANTBOT_LOCAL_UI_MODE': '1',
      'ANTBOT_LOCAL_UI_PORT': '$port',
    };

    final LaunchTarget target = _resolveBackendLaunchTarget();
    statusLine = '正在启动 ${target.label}...';
    notifyListeners();

    return Process.start(
      target.command,
      target.arguments,
      workingDirectory: target.workingDirectory,
      environment: environment,
      runInShell: false,
    );
  }

  LaunchTarget _resolveBackendLaunchTarget() {
    if (!kReleaseMode) {
      final repoRoot = Directory.current.uri.resolve('../../').toFilePath();
      if (Platform.isMacOS) {
        final electronBinary = File(
          '$repoRoot/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
        );
        if (electronBinary.existsSync()) {
          return LaunchTarget(
            label: 'Electron 本地引擎',
            command: electronBinary.path,
            arguments: const <String>['.'],
            workingDirectory: repoRoot,
          );
        }

        final packagedBackend = File(
          '$repoRoot/release/mac-arm64/搬运蚁.app/Contents/MacOS/搬运蚁',
        );
        if (packagedBackend.existsSync()) {
          return LaunchTarget(
            label: '打包后端',
            command: packagedBackend.path,
            arguments: const <String>[],
            workingDirectory: repoRoot,
          );
        }
      }

      if (Platform.isWindows) {
        final electronBinary = File(
          '$repoRoot\\node_modules\\electron\\dist\\electron.exe',
        );
        if (electronBinary.existsSync()) {
          return LaunchTarget(
            label: 'Electron 本地引擎',
            command: electronBinary.path,
            arguments: const <String>['.'],
            workingDirectory: repoRoot,
          );
        }

        final packagedBackend = File('$repoRoot\\release\\win-unpacked\\搬运蚁.exe');
        if (packagedBackend.existsSync()) {
          return LaunchTarget(
            label: '打包后端',
            command: packagedBackend.path,
            arguments: const <String>[],
            workingDirectory: packagedBackend.parent.path,
          );
        }
      }
    }

    final executable = File(Platform.resolvedExecutable).absolute;
    if (Platform.isMacOS) {
      final contentsDir = executable.parent.parent;
      final backendBinary = File(
        '${contentsDir.path}/Resources/backend/搬运蚁.app/Contents/MacOS/搬运蚁',
      );
      if (!backendBinary.existsSync()) {
        throw StateError('未找到内置后端，请重新执行 Flutter 打包脚本。');
      }
      return LaunchTarget(
        label: '内置后端',
        command: backendBinary.path,
        arguments: const <String>[],
        workingDirectory: contentsDir.path,
      );
    }

    if (Platform.isWindows) {
      final appDir = executable.parent;
      final backendDir = Directory(
        '${appDir.path}\\data\\backend',
      );
      final backendBinary = File('${backendDir.path}\\搬运蚁.exe');
      if (!backendBinary.existsSync()) {
        throw StateError('未找到内置后端，请重新执行 Flutter Windows 打包脚本。');
      }
      return LaunchTarget(
        label: '内置后端',
        command: backendBinary.path,
        arguments: const <String>[],
        workingDirectory: backendDir.path,
      );
    }

    throw StateError('当前平台暂未配置内置后端启动路径。');
  }

  void _bindBackendLogs(Process? process) {
    if (process == null) {
      return;
    }
    process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(_pushBackendLog);
    process.stderr
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(_pushBackendLog);
  }

  void _pushBackendLog(String line) {
    final trimmed = line.trim();
    if (trimmed.isEmpty) {
      return;
    }
    backendLogs.add(trimmed);
    if (backendLogs.length > 40) {
      backendLogs.removeAt(0);
    }
    if (!disposed && bootError.isNotEmpty) {
      notifyListeners();
    }
  }

  Future<void> _shutdownBackend() async {
    switchTimer?.cancel();
    pollTimer?.cancel();
    if (backendProcess != null) {
      backendProcess!.kill(ProcessSignal.sigterm);
      backendProcess = null;
    }
  }

  String _describeError(Object error) {
    final text = error.toString().replaceFirst('StateError: ', '').trim();
    return text.isEmpty ? '未知错误' : text;
  }

  @override
  void dispose() {
    disposed = true;
    composerController.dispose();
    _shutdownBackend();
    super.dispose();
  }
}

class LaunchTarget {
  const LaunchTarget({
    required this.label,
    required this.command,
    required this.arguments,
    required this.workingDirectory,
  });

  final String label;
  final String command;
  final List<String> arguments;
  final String workingDirectory;
}

class DashboardView extends StatelessWidget {
  const DashboardView({super.key, required this.controller});

  final AntbotController controller;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: shellCanvasColor(context),
      body: SafeArea(
        child: Row(
          children: <Widget>[
            SizedBox(width: 207, child: Sidebar(controller: controller)),
            Expanded(child: TaskWorkspace(controller: controller)),
          ],
        ),
      ),
    );
  }
}

enum WorkspaceAction {
  renameUser,
  openSettings,
  openRemote,
  openVoiceClone,
  openLogs,
  refreshNow,
  stopTasks,
}

class Sidebar extends StatelessWidget {
  const Sidebar({super.key, required this.controller});

  final AntbotController controller;

  @override
  Widget build(BuildContext context) {
    final app = controller.appInfo;
    final geminiReady = loginReady(controller.loginState, 'gemini');
    final remoteEnabled = readBool(controller.visibleSettings, const <String>[
      'remote',
      'enabled',
    ], false);
    return ColoredBox(
      color: sidebarSurfaceColor(context),
      child: Column(
        children: <Widget>[
          Container(
            height: 56,
            width: double.infinity,
            color: accentHeaderColor(context),
            padding: const EdgeInsets.fromLTRB(20, 0, 12, 0),
            child: Row(
              children: <Widget>[
                const Text(
                  '搬运蚁',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 20,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const Spacer(),
                Text(
                  '${stringOf(app['name']).isNotEmpty ? stringOf(app['name']) : 'antbot'} v${stringOf(app['version']).isNotEmpty ? stringOf(app['version']) : '0.0.0'}',
                  style: TextStyle(
                    color: Colors.white.withValues(alpha: 0.5),
                    fontSize: 10,
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: ColoredBox(
              color: sidebarInnerColor(context),
              child: Column(
                children: <Widget>[
                  Expanded(
                    child: ListView.builder(
                      padding: EdgeInsets.zero,
                      itemCount: controller.users.length,
                      itemBuilder: (context, index) {
                        final user = controller.users[index];
                        final userId = stringOf(user['id']);
                        return UserTile(
                          user: user,
                          active: controller.selectedUserId == userId,
                          loading: controller.loadingUserId == userId,
                          onTap: () => controller.selectUser(userId),
                        );
                      },
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(0, 14, 0, 18),
                    child: SizedBox(
                      width: 100,
                      height: 34,
                      child: TextButton(
                        onPressed: controller.actionBusy
                            ? null
                            : () async {
                                final name = await promptText(
                                  context,
                                  title: '添加用户',
                                  hint: '输入用户名，可留空自动命名',
                                );
                                if (name == null) {
                                  return;
                                }
                                await controller.createUser(name);
                              },
                        style: TextButton.styleFrom(
                          backgroundColor: elevatedButtonBackground(
                            context,
                            false,
                          ),
                          foregroundColor: actionButtonForeground(
                            context,
                            false,
                          ),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(6),
                          ),
                        ),
                        child: const Text(
                          '添加用户',
                          style: TextStyle(fontSize: 10),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          Container(
            height: 122,
            width: double.infinity,
            color: sidebarSurfaceColor(context),
            padding: const EdgeInsets.fromLTRB(19, 22, 19, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                SizedBox(
                  width: 132,
                  height: 30,
                  child: TextButton(
                    onPressed: controller.actionBusy
                        ? null
                        : () => openLoginPreviewDialog(
                            context,
                            controller,
                            'gemini',
                          ),
                    style: TextButton.styleFrom(
                      backgroundColor: elevatedButtonBackground(
                        context,
                        geminiReady,
                      ),
                      foregroundColor: actionButtonForeground(
                        context,
                        geminiReady,
                      ),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(6),
                      ),
                    ),
                    child: Text(
                      geminiReady ? 'Gemini已登录' : 'Gemini登录',
                      maxLines: 1,
                      overflow: TextOverflow.visible,
                      softWrap: false,
                      style: const TextStyle(fontSize: 10),
                    ),
                  ),
                ),
                const Spacer(),
                Row(
                  children: <Widget>[
                    SidebarFooterButton(
                      label: '全部设置',
                      active: false,
                      onTap: () => openSettingsDialog(context, controller),
                    ),
                    const SizedBox(width: 14),
                    SidebarFooterButton(
                      label: remoteEnabled ? '远程已开' : '远程访问',
                      active: remoteEnabled,
                      onTap: () => openRemoteDialog(context, controller),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class UserTile extends StatelessWidget {
  const UserTile({
    super.key,
    required this.user,
    required this.active,
    required this.loading,
    required this.onTap,
  });

  final JsonMap user;
  final bool active;
  final bool loading;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final avatarId = readInt(user, const <String>['avatarId'], 1).clamp(1, 5);
    final liveCount = readInt(user, const <String>['liveTaskCount'], 0);
    final accent = Theme.of(context).colorScheme.primary;
    final activeBackground = active
        ? (isDarkMode(context)
              ? const Color(0xFF1E2A3A)
              : const Color(0xFFF1F6FF))
        : sidebarInnerColor(context);
    final activeBorder = active
        ? (isDarkMode(context)
              ? const Color(0xFF40628F)
              : const Color(0xFFD7E6FF))
        : subtleBorderColor(context);
    final activeBadgeBackground = active
        ? (isDarkMode(context)
              ? const Color(0xFF2A405B)
              : const Color(0xFFE6F0FF))
        : Colors.transparent;
    final infoTextColor = active
        ? (isDarkMode(context) ? const Color(0xFFD6E6FF) : accent)
        : secondaryTextColor(context);

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          curve: Curves.easeOutCubic,
          height: 56,
          padding: const EdgeInsets.fromLTRB(0, 4, 8, 4),
          decoration: BoxDecoration(
            color: activeBackground,
            border: Border(
              top: BorderSide(color: subtleBorderColor(context), width: 1),
              left: BorderSide(
                color: active ? accent : Colors.transparent,
                width: 3,
              ),
            ),
            boxShadow: active
                ? <BoxShadow>[
                    BoxShadow(
                      color: accent.withValues(
                        alpha: isDarkMode(context) ? 0.18 : 0.08,
                      ),
                      blurRadius: 14,
                      offset: const Offset(0, 6),
                    ),
                  ]
                : const <BoxShadow>[],
          ),
          child: Row(
            children: <Widget>[
              const SizedBox(width: 4),
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(5),
                  border: Border.all(color: activeBorder),
                ),
                clipBehavior: Clip.antiAlias,
                child: Image.asset(
                  'assets/figma/avatar-$avatarId.png',
                  fit: BoxFit.cover,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: Text(
                            stringOf(user['name']).isNotEmpty
                                ? stringOf(user['name'])
                                : '未命名用户',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w700,
                            ).copyWith(color: primaryTextColor(context)),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          loading
                              ? '切换中...'
                              : (liveCount > 0 ? '当前：$liveCount' : '无任务'),
                          style: TextStyle(fontSize: 10, color: infoTextColor),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 6,
                        vertical: 2,
                      ),
                      decoration: BoxDecoration(
                        color: activeBadgeBackground,
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        '历史任务：${readInt(user, const <String>['historyCount'], 0)}',
                        style: TextStyle(fontSize: 10, color: infoTextColor),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class HeaderBar extends StatelessWidget {
  const HeaderBar({super.key, required this.controller});

  final AntbotController controller;

  @override
  Widget build(BuildContext context) {
    final activeUser = controller.activeUser;
    return Container(
      height: 56,
      color: cardSurfaceColor(context),
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 0),
      child: Row(
        children: <Widget>[
          Expanded(
            child: AnimatedSwitcher(
              duration: const Duration(milliseconds: 160),
              child: Text(
                stringOf(activeUser['name']).isNotEmpty
                    ? stringOf(activeUser['name'])
                    : '当前用户',
                key: ValueKey<String>(stringOf(activeUser['id'])),
                style: const TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w700,
                ).copyWith(color: primaryTextColor(context)),
              ),
            ),
          ),
          LoginIconButton(
            label: '视频号',
            active: loginReady(controller.loginState, 'videoChannel'),
            onTap: () =>
                openLoginPreviewDialog(context, controller, 'videoChannel'),
          ),
          const SizedBox(width: 16),
          LoginIconButton(
            label: '抖音',
            active: loginReady(controller.loginState, 'douyin'),
            onTap: () => openLoginPreviewDialog(context, controller, 'douyin'),
          ),
          const SizedBox(width: 16),
          HeaderMenuButton(
            onSelected: (action) =>
                handleWorkspaceAction(context, controller, action),
          ),
        ],
      ),
    );
  }
}

class LoginIconButton extends StatelessWidget {
  const LoginIconButton({
    super.key,
    required this.label,
    required this.active,
    required this.onTap,
  });

  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: onTap,
      style: textActionButtonStyle(context, active: active),
      child: Text('$label-${active ? '已登录' : '登录'}'),
    );
  }
}

class TaskWorkspace extends StatelessWidget {
  const TaskWorkspace({super.key, required this.controller});

  final AntbotController controller;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: workspaceSurfaceColor(context),
      child: Column(
        children: <Widget>[
          HeaderBar(controller: controller),
          if (controller.runtimeHint.isNotEmpty)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(20, 10, 20, 8),
              child: Text(
                controller.runtimeHint,
                style: TextStyle(
                  fontSize: 12,
                  color: Theme.of(context).colorScheme.primary,
                ),
              ),
            ),
          Expanded(child: TaskFeed(controller: controller)),
          ComposerBar(controller: controller),
        ],
      ),
    );
  }
}

class TaskFeed extends StatelessWidget {
  const TaskFeed({super.key, required this.controller});

  final AntbotController controller;

  @override
  Widget build(BuildContext context) {
    final entries = buildConversationEntries(controller);

    if (entries.isEmpty) {
      return Center(
        child: Text(
          '当前用户还没有任务记录。底部输入区会固定停靠在窗口底部，输入后可直接发送。',
          textAlign: TextAlign.center,
          style: TextStyle(
            color: secondaryTextColor(context),
            fontSize: 12,
            height: 1.7,
          ),
        ),
      );
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        final maxBubbleWidth = constraints.maxWidth > 620
            ? 428.0
            : constraints.maxWidth * 0.72;
        final children = entries.reversed
            .map((entry) {
              final kind = stringOf(entry['kind']);
              if (kind == 'sent') {
                return Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Align(
                    alignment: Alignment.centerRight,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: <Widget>[
                        Padding(
                          padding: const EdgeInsets.only(right: 8, bottom: 6),
                          child: Text(
                            formatBubbleTime(stringOf(entry['time'])),
                            style: bubbleTimeTextStyle(context),
                          ),
                        ),
                        ConstrainedBox(
                          constraints: BoxConstraints(maxWidth: maxBubbleWidth),
                          child: TaskBubble(
                            text: stringOf(entry['text']),
                            selectable: true,
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              }

              return Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: <Widget>[
                      ConstrainedBox(
                        constraints: BoxConstraints(maxWidth: maxBubbleWidth),
                        child: TaskStatusStrip(
                          title: stringOf(entry['title']),
                          detail: stringOf(entry['detail']),
                          status: stringOf(entry['status']),
                          progress: readDouble(entry, const <String>[
                            'progress',
                          ], 0).clamp(0, 1),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.only(left: 8, bottom: 6),
                        child: Text(
                          formatBubbleTime(stringOf(entry['time'])),
                          style: bubbleTimeTextStyle(context),
                        ),
                      ),
                    ],
                  ),
                ),
              );
            })
            .toList(growable: false);

        return ListView(
          reverse: true,
          padding: const EdgeInsets.fromLTRB(18, 18, 18, 12),
          children: children,
        );
      },
    );
  }
}

class ComposerBar extends StatelessWidget {
  const ComposerBar({super.key, required this.controller});

  final AntbotController controller;

  @override
  Widget build(BuildContext context) {
    final settings = controller.visibleSettings;
    final voiceSpeed = readDouble(settings, const <String>[
      'style',
      'voiceSpeed',
    ], 1.1).toStringAsFixed(1);
    final retries = readInt(settings, const <String>[
      'retry',
      'failedTaskRetries',
    ], 0);
    final voiceoverEnabled = readBool(settings, const <String>[
      'style',
      'voiceoverEnabled',
    ], true);
    final subtitleEnabled = readBool(settings, const <String>[
      'style',
      'subtitleEnabled',
    ], true);
    final publishEnabled = readBool(settings, const <String>[
      'publish',
      'enabled',
    ], true);
    final voiceId = readString(settings, const <String>[
      'voiceClone',
      'voiceId',
    ], '');
    final voiceLabel = voiceId.isNotEmpty
        ? voiceId
        : readString(settings, const <String>[
            'voiceClone',
            'profileName',
          ], '未配置');
    final subtitleColor = parseHexColor(
      readString(settings, const <String>[
        'style',
        'subtitleTextColor',
      ], '#FFA100'),
    );
    final strokeColor = parseHexColor(
      readString(settings, const <String>[
        'style',
        'subtitleStrokeColor',
      ], '#000000'),
    );

    return Container(
      color: composerSurfaceColor(context),
      padding: const EdgeInsets.fromLTRB(18, 0, 18, 8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Container(
            padding: const EdgeInsets.fromLTRB(11, 8, 11, 8),
            decoration: BoxDecoration(
              color: inputSurfaceColor(context),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: subtleBorderColor(context)),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: <Widget>[
                Expanded(
                  child: SizedBox(
                    height: 82,
                    child: TextField(
                      controller: controller.composerController,
                      minLines: 4,
                      maxLines: 4,
                      style: TextStyle(
                        fontSize: 12,
                        height: 1.45,
                        color: primaryTextColor(context),
                      ),
                      decoration: InputDecoration(
                        border: InputBorder.none,
                        hintStyle: TextStyle(
                          fontSize: 12,
                          color: secondaryTextColor(context),
                          height: 1.45,
                        ),
                        hintText:
                            '视频文案、话题、发布时间(3月8日17时38分)、任务名/原创/不原创、视频链接、时间段(0:12-1:30)。文案、话题、时间可以留空。',
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                ValueListenableBuilder<TextEditingValue>(
                  valueListenable: controller.composerController,
                  builder: (context, value, _) {
                    final enabled =
                        value.text.trim().isNotEmpty && !controller.actionBusy;
                    return SizedBox(
                      width: 72,
                      height: 82,
                      child: FilledButton(
                        onPressed: enabled ? controller.startTasks : null,
                        style: FilledButton.styleFrom(
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                        ),
                        child: const Text(
                          '发送',
                          style: TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    );
                  },
                ),
              ],
            ),
          ),
          const SizedBox(height: 5),
          SizedBox(
            height: 24,
            child: Row(
              children: <Widget>[
                Expanded(
                  child: ListView(
                    scrollDirection: Axis.horizontal,
                    children: <Widget>[
                      QuickPopupPill<double>(
                        label: '语速',
                        value: voiceSpeed,
                        backgroundColor: const Color(0xFF2978FF),
                        options: List<double>.generate(
                          11,
                          (index) => 0.8 + index * 0.1,
                        ),
                        optionLabel: (value) => value.toStringAsFixed(1),
                        onSelected: (value) =>
                            controller.patchSettings(<String, dynamic>{
                              'style': <String, dynamic>{'voiceSpeed': value},
                            }),
                      ),
                      const SizedBox(width: 12),
                      VoiceQuickPill(
                        label: voiceLabel,
                        onEdit: () async {
                          final next = await promptText(
                            context,
                            title: '设置音色 ID',
                            hint: '输入当前要使用的音色 ID',
                            initialValue: voiceId,
                          );
                          if (next == null) {
                            return;
                          }
                          await controller.updateVoiceId(next);
                        },
                        onOpenClone: () =>
                            openVoiceCloneDialog(context, controller),
                      ),
                      const SizedBox(width: 12),
                      QuickPopupPill<int>(
                        label: '重试次数',
                        value: '$retries',
                        backgroundColor: const Color(0xFFEA5154),
                        options: List<int>.generate(11, (index) => index),
                        optionLabel: (value) => '$value',
                        onSelected: (value) =>
                            controller.patchSettings(<String, dynamic>{
                              'retry': <String, dynamic>{
                                'failedTaskRetries': value,
                              },
                            }),
                      ),
                      const SizedBox(width: 12),
                      QuickTogglePill(
                        label: '旁白语音',
                        active: voiceoverEnabled,
                        backgroundColor: const Color(0xFF3BB880),
                        onTap: controller.toggleVoiceover,
                      ),
                      const SizedBox(width: 12),
                      QuickTogglePill(
                        label: '字幕',
                        active: subtitleEnabled,
                        backgroundColor: const Color(0xFF707D93),
                        onTap: voiceoverEnabled
                            ? controller.toggleSubtitle
                            : null,
                      ),
                      const SizedBox(width: 12),
                      QuickTogglePill(
                        label: '自动发布',
                        active: publishEnabled,
                        backgroundColor: const Color(0xFFEA7A39),
                        onTap: controller.togglePublish,
                      ),
                      const SizedBox(width: 12),
                      QuickColorPill(
                        label: '字幕颜色',
                        color: subtitleColor,
                        onChanged: controller.changeSubtitleColor,
                      ),
                      const SizedBox(width: 12),
                      QuickColorPill(
                        label: '字幕边框颜色',
                        color: strokeColor,
                        onChanged: controller.changeStrokeColor,
                      ),
                    ],
                  ),
                ),
                if (controller.savingQuickSetting) ...<Widget>[
                  const SizedBox(width: 12),
                  const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class SidebarFooterButton extends StatelessWidget {
  const SidebarFooterButton({
    super.key,
    required this.label,
    required this.active,
    required this.onTap,
  });

  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: onTap,
      style: textActionButtonStyle(context, active: active),
      child: Text(label),
    );
  }
}

class HeaderMenuButton extends StatelessWidget {
  const HeaderMenuButton({super.key, required this.onSelected});

  final Future<void> Function(WorkspaceAction action) onSelected;

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<WorkspaceAction>(
      tooltip: '更多操作',
      onSelected: (value) {
        onSelected(value);
      },
      itemBuilder: (context) => const <PopupMenuEntry<WorkspaceAction>>[
        PopupMenuItem<WorkspaceAction>(
          value: WorkspaceAction.renameUser,
          child: Text('重命名用户'),
        ),
        PopupMenuItem<WorkspaceAction>(
          value: WorkspaceAction.openSettings,
          child: Text('全部设置'),
        ),
        PopupMenuItem<WorkspaceAction>(
          value: WorkspaceAction.openRemote,
          child: Text('远程访问'),
        ),
        PopupMenuItem<WorkspaceAction>(
          value: WorkspaceAction.openVoiceClone,
          child: Text('语音克隆'),
        ),
        PopupMenuItem<WorkspaceAction>(
          value: WorkspaceAction.openLogs,
          child: Text('查看日志'),
        ),
        PopupMenuItem<WorkspaceAction>(
          value: WorkspaceAction.refreshNow,
          child: Text('同步刷新'),
        ),
        PopupMenuItem<WorkspaceAction>(
          value: WorkspaceAction.stopTasks,
          child: Text('停止任务'),
        ),
      ],
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: elevatedButtonBackground(context, false),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: subtleBorderColor(context)),
        ),
        child: Text(
          '更多',
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w600,
            color: actionButtonForeground(context, false),
          ),
        ),
      ),
    );
  }
}

class TaskBubble extends StatelessWidget {
  const TaskBubble({
    super.key,
    required this.text,
    this.minHeight = 0,
    this.selectable = false,
  });

  final String text;
  final double minHeight;
  final bool selectable;

  @override
  Widget build(BuildContext context) {
    final content = Text(
      text,
      style: const TextStyle(fontSize: 12, color: Colors.white, height: 1.45),
    );

    return Container(
      constraints: BoxConstraints(minHeight: minHeight),
      padding: const EdgeInsets.fromLTRB(11, 10, 11, 10),
      decoration: BoxDecoration(
        color: const Color(0xFF45AB6A),
        borderRadius: BorderRadius.circular(12),
      ),
      child: selectable ? SelectionArea(child: content) : content,
    );
  }
}

class DateStamp extends StatelessWidget {
  const DateStamp({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Center(
        child: Text(
          label,
          style: const TextStyle(fontSize: 12, color: Color(0x66000000)),
        ),
      ),
    );
  }
}

class TaskStatusStrip extends StatelessWidget {
  const TaskStatusStrip({
    super.key,
    required this.title,
    required this.detail,
    required this.status,
    required this.progress,
  });

  final String title;
  final String detail;
  final String status;
  final double progress;

  @override
  Widget build(BuildContext context) {
    final theme = taskStatusTheme(context, status);
    final showProgress = status == 'running' && progress > 0;
    final showStoppedIcon = status == 'stopped';
    final showFailedIcon = status == 'failed' || status == 'partial_failed';

    return DecoratedBox(
      decoration: BoxDecoration(
        color: theme.background,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: theme.border),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(13, 11, 13, 11),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 3,
                  ),
                  decoration: BoxDecoration(
                    color: theme.badge,
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    taskStatusLabel(status),
                    style: const TextStyle(
                      fontSize: 10,
                      color: Colors.white,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                if (showFailedIcon || showStoppedIcon) ...<Widget>[
                  const SizedBox(width: 8),
                  _SvgAssetIcon(
                    assetPath: showStoppedIcon
                        ? 'assets/figma/icon-task-stopped.svg'
                        : 'assets/figma/icon-task-failed.svg',
                    size: 16,
                  ),
                ],
              ],
            ),
            if (title.isNotEmpty) ...<Widget>[
              const SizedBox(height: 8),
              Text(
                title,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  color: primaryTextColor(context),
                  height: 1.35,
                ),
              ),
            ],
            if (detail.isNotEmpty) ...<Widget>[
              const SizedBox(height: 4),
              SelectionArea(
                child: Text(
                  detail,
                  style: TextStyle(
                    fontSize: 12,
                    color: secondaryTextColor(context),
                    height: 1.45,
                  ),
                ),
              ),
            ],
            if (showProgress) ...<Widget>[
              const SizedBox(height: 10),
              ClipRRect(
                borderRadius: BorderRadius.circular(999),
                child: SizedBox(
                  width: 168,
                  height: 4,
                  child: LinearProgressIndicator(
                    value: progress,
                    backgroundColor: const Color(0xFFE4E8EF),
                    valueColor: AlwaysStoppedAnimation<Color>(theme.badge),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class QuickPopupPill<T> extends StatelessWidget {
  const QuickPopupPill({
    super.key,
    required this.label,
    required this.value,
    required this.backgroundColor,
    required this.options,
    required this.optionLabel,
    required this.onSelected,
  });

  final String label;
  final String value;
  final Color backgroundColor;
  final List<T> options;
  final String Function(T value) optionLabel;
  final Future<void> Function(T value) onSelected;

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<T>(
      tooltip: '$label：$value',
      onSelected: (value) {
        onSelected(value);
      },
      itemBuilder: (context) {
        return options
            .map(
              (item) =>
                  PopupMenuItem<T>(value: item, child: Text(optionLabel(item))),
            )
            .toList(growable: false);
      },
      child: Container(
        height: 24,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: backgroundColor,
          borderRadius: BorderRadius.circular(6),
        ),
        alignment: Alignment.center,
        child: Text(
          '$label：$value',
          style: const TextStyle(fontSize: 10, color: Colors.white),
        ),
      ),
    );
  }
}

class VoiceQuickPill extends StatelessWidget {
  const VoiceQuickPill({
    super.key,
    required this.label,
    required this.onEdit,
    required this.onOpenClone,
  });

  final String label;
  final Future<void> Function() onEdit;
  final Future<void> Function() onOpenClone;

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<String>(
      tooltip: '音色：$label',
      onSelected: (value) {
        if (value == 'edit') {
          onEdit();
          return;
        }
        onOpenClone();
      },
      itemBuilder: (context) => const <PopupMenuEntry<String>>[
        PopupMenuItem<String>(value: 'edit', child: Text('设置音色 ID')),
        PopupMenuItem<String>(value: 'clone', child: Text('打开语音克隆')),
      ],
      child: Container(
        height: 24,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: const Color(0xFFEEAB1C),
          borderRadius: BorderRadius.circular(6),
        ),
        alignment: Alignment.center,
        child: Text(
          '音色：$label',
          style: const TextStyle(fontSize: 10, color: Colors.white),
        ),
      ),
    );
  }
}

class QuickTogglePill extends StatelessWidget {
  const QuickTogglePill({
    super.key,
    required this.label,
    required this.active,
    required this.backgroundColor,
    required this.onTap,
  });

  final String label;
  final bool active;
  final Color backgroundColor;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final fill = toggleBackgroundColor(
      context,
      active: active,
      activeColor: backgroundColor,
    );
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Opacity(
        opacity: onTap == null ? 0.45 : 1,
        child: Container(
          height: 24,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(
            color: fill,
            borderRadius: BorderRadius.circular(6),
          ),
          alignment: Alignment.center,
          child: Text(
            '$label：${active ? '开' : '关'}',
            style: TextStyle(
              fontSize: 10,
              color: toggleForegroundColor(context, active: active),
            ),
          ),
        ),
      ),
    );
  }
}

class QuickColorPill extends StatelessWidget {
  const QuickColorPill({
    super.key,
    required this.label,
    required this.color,
    required this.onChanged,
  });

  final String label;
  final Color color;
  final Future<void> Function(Color color) onChanged;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(6),
      onTap: () async {
        final picked = await openColorPaletteDialog(context, label, color);
        if (picked == null) {
          return;
        }
        await onChanged(picked);
      },
      child: Container(
        height: 24,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        decoration: BoxDecoration(
          color: inputSurfaceColor(context),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: subtleBorderColor(context)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              '$label：',
              style: TextStyle(fontSize: 10, color: primaryTextColor(context)),
            ),
            Container(
              width: 12,
              height: 12,
              margin: const EdgeInsets.only(left: 4),
              decoration: BoxDecoration(
                color: color,
                borderRadius: BorderRadius.circular(2),
                border: Border.all(color: subtleBorderColor(context)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SvgAssetIcon extends StatelessWidget {
  const _SvgAssetIcon({required this.assetPath, required this.size});

  final String assetPath;
  final double size;

  @override
  Widget build(BuildContext context) {
    return SvgPicture.asset(
      assetPath,
      width: size,
      height: size,
      fit: BoxFit.contain,
    );
  }
}

class SidePanel extends StatelessWidget {
  const SidePanel({super.key, required this.controller});

  final AntbotController controller;

  @override
  Widget build(BuildContext context) {
    final progress = controller.progress;
    final running = boolOf(progress['running']);
    final platformReady =
        loginReady(controller.loginState, 'videoChannel') ||
        loginReady(controller.loginState, 'douyin');

    return ListView(
      children: <Widget>[
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: <Widget>[
            MetricCard(
              title: '运行状态',
              value: running ? '执行中' : '空闲',
              accent: running
                  ? const Color(0xFF45AB6A)
                  : const Color(0xFF707D93),
            ),
            MetricCard(
              title: '排队批次',
              value: '${readInt(progress, const <String>['queueLength'], 0)}',
              accent: const Color(0xFF2978FF),
            ),
            MetricCard(
              title: '平台状态',
              value: platformReady ? '已就绪' : '未登录',
              accent: platformReady
                  ? const Color(0xFF45AB6A)
                  : const Color(0xFFEA7A39),
            ),
          ],
        ),
        const SizedBox(height: 16),
        RemotePanel(controller: controller),
        const SizedBox(height: 16),
        QuickSettingsPanel(controller: controller),
        const SizedBox(height: 16),
        LogPanel(logs: controller.logs),
      ],
    );
  }
}

class RemotePanel extends StatelessWidget {
  const RemotePanel({super.key, required this.controller});

  final AntbotController controller;

  @override
  Widget build(BuildContext context) {
    final server = controller.server;
    final settings = controller.visibleSettings;
    final urls = listOfStrings(server['urls']);
    final publicInfo = mapOf(server['public']);
    final remoteEnabled = readBool(settings, const <String>[
      'remote',
      'enabled',
    ], false);

    return PanelCard(
      title: '远程访问',
      trailing: FilledButton.tonal(
        onPressed: controller.actionBusy ? null : controller.toggleRemote,
        child: Text(remoteEnabled ? '关闭远程' : '开启公网 + 内网'),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          LabelValueRow(
            label: '状态',
            value: server.isEmpty
                ? '未加载'
                : (boolOf(server['online'])
                      ? '本地服务在线'
                      : (stringOf(server['lastError']).isNotEmpty
                            ? stringOf(server['lastError'])
                            : '未开启')),
          ),
          const SizedBox(height: 10),
          LabelValueRow(
            label: '内网地址',
            value: urls.isNotEmpty ? urls.join('\n') : '未开启',
            trailing: urls.isEmpty
                ? null
                : IconButton(
                    tooltip: '复制地址',
                    onPressed: () =>
                        Clipboard.setData(ClipboardData(text: urls.first)),
                    icon: const Icon(Icons.copy_rounded, size: 16),
                  ),
          ),
          const SizedBox(height: 10),
          LabelValueRow(
            label: '公网地址',
            value: stringOf(publicInfo['url']).isNotEmpty
                ? stringOf(publicInfo['url'])
                : (stringOf(publicInfo['lastError']).isNotEmpty
                      ? stringOf(publicInfo['lastError'])
                      : '未开启'),
            trailing: stringOf(publicInfo['url']).isEmpty
                ? null
                : IconButton(
                    tooltip: '复制地址',
                    onPressed: () => Clipboard.setData(
                      ClipboardData(text: stringOf(publicInfo['url'])),
                    ),
                    icon: const Icon(Icons.copy_rounded, size: 16),
                  ),
          ),
        ],
      ),
    );
  }
}

class QuickSettingsPanel extends StatelessWidget {
  const QuickSettingsPanel({super.key, required this.controller});

  final AntbotController controller;

  @override
  Widget build(BuildContext context) {
    final settings = controller.visibleSettings;
    final voiceSpeed = readDouble(settings, const <String>[
      'style',
      'voiceSpeed',
    ], 1.1).toStringAsFixed(1);
    final retries = readInt(settings, const <String>[
      'retry',
      'failedTaskRetries',
    ], 0);
    final voiceover = readBool(settings, const <String>[
      'style',
      'voiceoverEnabled',
    ], true);
    final subtitle = readBool(settings, const <String>[
      'style',
      'subtitleEnabled',
    ], true);
    final publishEnabled = readBool(settings, const <String>[
      'publish',
      'enabled',
    ], true);
    final subtitleColor = parseHexColor(
      readString(settings, const <String>[
        'style',
        'subtitleTextColor',
      ], '#FFA100'),
    );
    final strokeColor = parseHexColor(
      readString(settings, const <String>[
        'style',
        'subtitleStrokeColor',
      ], '#000000'),
    );

    return PanelCard(
      title: '快捷参数',
      trailing: controller.savingQuickSetting
          ? const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : null,
      child: Wrap(
        spacing: 10,
        runSpacing: 10,
        children: <Widget>[
          StepChip(
            label: '语速',
            value: voiceSpeed,
            color: const Color(0xFF2978FF),
            onMinus: () => controller.adjustVoiceSpeed(-1),
            onPlus: () => controller.adjustVoiceSpeed(1),
          ),
          StepChip(
            label: '重试',
            value: '$retries',
            color: const Color(0xFFEA5154),
            onMinus: () => controller.adjustRetryCount(-1),
            onPlus: () => controller.adjustRetryCount(1),
          ),
          ToggleChip(
            label: '旁白语音',
            active: voiceover,
            color: const Color(0xFF3BB880),
            onTap: controller.toggleVoiceover,
          ),
          ToggleChip(
            label: '字幕',
            active: subtitle,
            color: const Color(0xFF707D93),
            onTap: voiceover ? controller.toggleSubtitle : null,
          ),
          ToggleChip(
            label: '自动发布',
            active: publishEnabled,
            color: const Color(0xFFEA7A39),
            onTap: controller.togglePublish,
          ),
          ColorChip(
            label: '字幕颜色',
            color: subtitleColor,
            onChanged: controller.changeSubtitleColor,
          ),
          ColorChip(
            label: '字幕边框颜色',
            color: strokeColor,
            onChanged: controller.changeStrokeColor,
          ),
        ],
      ),
    );
  }
}

class LogPanel extends StatelessWidget {
  const LogPanel({super.key, required this.logs});

  final List<JsonMap> logs;

  @override
  Widget build(BuildContext context) {
    return PanelCard(
      title: '最近日志',
      child: logs.isEmpty
          ? const Text('暂无日志。', style: TextStyle(color: Color(0xFF6B7688)))
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: logs.take(8).map((item) {
                final message = stringOf(item['message']);
                return Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Text(
                    '[${formatDate(stringOf(item['timestamp']))}] $message',
                    style: const TextStyle(
                      fontSize: 12,
                      color: Color(0xFF434D61),
                      height: 1.5,
                    ),
                  ),
                );
              }).toList(),
            ),
    );
  }
}

class MetricCard extends StatelessWidget {
  const MetricCard({
    super.key,
    required this.title,
    required this.value,
    required this.accent,
  });

  final String title;
  final String value;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 100,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(18),
          boxShadow: const <BoxShadow>[
            BoxShadow(
              color: Color.fromRGBO(17, 31, 58, 0.06),
              blurRadius: 18,
              offset: Offset(0, 10),
            ),
          ],
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                title,
                style: const TextStyle(color: Color(0xFF6B7688), fontSize: 12),
              ),
              const SizedBox(height: 8),
              Text(
                value,
                style: TextStyle(
                  color: accent,
                  fontSize: 18,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class PanelCard extends StatelessWidget {
  const PanelCard({
    super.key,
    required this.title,
    required this.child,
    this.trailing,
  });

  final String title;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.96),
        borderRadius: BorderRadius.circular(24),
        boxShadow: const <BoxShadow>[
          BoxShadow(
            color: Color.fromRGBO(18, 33, 58, 0.08),
            blurRadius: 22,
            offset: Offset(0, 12),
          ),
        ],
      ),
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    title,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                if (trailing != null) ...<Widget>[trailing!],
              ],
            ),
            const SizedBox(height: 14),
            child,
          ],
        ),
      ),
    );
  }
}

class LabelValueRow extends StatelessWidget {
  const LabelValueRow({
    super.key,
    required this.label,
    required this.value,
    this.trailing,
  });

  final String label;
  final String value;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        SizedBox(
          width: 72,
          child: Text(
            label,
            style: const TextStyle(color: Color(0xFF6B7688), fontSize: 12),
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: const TextStyle(
              fontSize: 12,
              height: 1.5,
              color: Color(0xFF171C27),
            ),
          ),
        ),
        if (trailing != null) ...<Widget>[trailing!],
      ],
    );
  }
}

class StepChip extends StatelessWidget {
  const StepChip({
    super.key,
    required this.label,
    required this.value,
    required this.color,
    required this.onMinus,
    required this.onPlus,
  });

  final String label;
  final String value;
  final Color color;
  final VoidCallback onMinus;
  final VoidCallback onPlus;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            label,
            style: const TextStyle(color: Colors.white70, fontSize: 12),
          ),
          const SizedBox(width: 10),
          _ChipActionButton(symbol: '-', onTap: onMinus),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Text(
              value,
              style: const TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.w700,
                fontSize: 12,
              ),
            ),
          ),
          _ChipActionButton(symbol: '+', onTap: onPlus),
        ],
      ),
    );
  }
}

class ToggleChip extends StatelessWidget {
  const ToggleChip({
    super.key,
    required this.label,
    required this.active,
    required this.color,
    required this.onTap,
  });

  final String label;
  final bool active;
  final Color color;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final fill = toggleBackgroundColor(
      context,
      active: active,
      activeColor: color,
    );
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Opacity(
        opacity: onTap == null ? 0.46 : 1,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
          decoration: BoxDecoration(
            color: fill,
            borderRadius: BorderRadius.circular(16),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(
                label,
                style: TextStyle(
                  color: toggleForegroundColor(
                    context,
                    active: active,
                  ).withValues(alpha: active ? 0.72 : 1),
                  fontSize: 12,
                ),
              ),
              const SizedBox(width: 10),
              Text(
                active ? '开' : '关',
                style: TextStyle(
                  color: toggleForegroundColor(context, active: active),
                  fontWeight: FontWeight.w700,
                  fontSize: 12,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class ColorChip extends StatelessWidget {
  const ColorChip({
    super.key,
    required this.label,
    required this.color,
    required this.onChanged,
  });

  final String label;
  final Color color;
  final Future<void> Function(Color color) onChanged;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () async {
        final picked = await openColorPaletteDialog(context, label, color);
        if (picked == null) {
          return;
        }
        await onChanged(picked);
      },
      borderRadius: BorderRadius.circular(16),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: inputSurfaceColor(context),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: subtleBorderColor(context)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              label,
              style: TextStyle(
                color: secondaryTextColor(context),
                fontSize: 12,
              ),
            ),
            const SizedBox(width: 10),
            Container(
              width: 20,
              height: 20,
              decoration: BoxDecoration(
                color: color,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: subtleBorderColor(context)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

Future<Color?> openColorPaletteDialog(
  BuildContext context,
  String title,
  Color currentColor,
) {
  const palette = <Color>[
    Color(0xFFFFA100),
    Color(0xFFFF6F61),
    Color(0xFFFF5C8A),
    Color(0xFFEA5154),
    Color(0xFFEEAB1C),
    Color(0xFF45AB6A),
    Color(0xFF2EB6A3),
    Color(0xFF2978FF),
    Color(0xFF7868E6),
    Color(0xFF000000),
    Color(0xFFFFFFFF),
    Color(0xFF8C95A3),
  ];

  return showDialog<Color>(
    context: context,
    builder: (dialogContext) {
      return AlertDialog(
        title: Text(title),
        content: SizedBox(
          width: 320,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                '当前颜色 ${colorToHex(currentColor)}',
                style: const TextStyle(fontSize: 12, color: Color(0xFF6B7688)),
              ),
              const SizedBox(height: 14),
              Wrap(
                spacing: 10,
                runSpacing: 10,
                children: palette
                    .map((candidate) {
                      final selected =
                          colorToHex(candidate) == colorToHex(currentColor);
                      return InkWell(
                        onTap: () => Navigator.of(dialogContext).pop(candidate),
                        borderRadius: BorderRadius.circular(10),
                        child: Container(
                          width: 42,
                          height: 42,
                          decoration: BoxDecoration(
                            color: candidate,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(
                              color: selected
                                  ? const Color(0xFF2978FF)
                                  : const Color(0xFFD5DCE7),
                              width: selected ? 2 : 1,
                            ),
                          ),
                          child: selected
                              ? const Icon(
                                  Icons.check_rounded,
                                  color: Colors.white,
                                  size: 18,
                                )
                              : null,
                        ),
                      );
                    })
                    .toList(growable: false),
              ),
            ],
          ),
        ),
      );
    },
  );
}

class _ChipActionButton extends StatelessWidget {
  const _ChipActionButton({required this.symbol, required this.onTap});

  final String symbol;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        width: 22,
        height: 22,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(8),
          color: Colors.white.withValues(alpha: 0.2),
        ),
        alignment: Alignment.center,
        child: Text(symbol, style: const TextStyle(color: Colors.white)),
      ),
    );
  }
}

class SectionTitle extends StatelessWidget {
  const SectionTitle({super.key, required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Text(
        title,
        style: const TextStyle(
          fontSize: 13,
          color: Color(0xFF99A4B6),
          letterSpacing: 1.6,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class TaskCard extends StatelessWidget {
  const TaskCard({super.key, required this.task, required this.live});

  final JsonMap task;
  final bool live;

  @override
  Widget build(BuildContext context) {
    final status = stringOf(task['status']).isNotEmpty
        ? stringOf(task['status'])
        : 'pending';
    final progress = readDouble(task, const <String>[
      'progress',
    ], 0).clamp(0, 100);
    final accent = switch (status) {
      'completed' => const Color(0xFF8CC49F),
      'failed' => const Color(0xFFE68F97),
      'stopped' => const Color(0xFF9DA6B3),
      'running' => const Color(0xFF8DC7A0),
      _ => const Color(0xFFCBD4E0),
    };
    final background = switch (status) {
      'completed' => const Color(0xFFDCEFE3),
      'failed' => const Color(0xFFF5D6D9),
      'stopped' => const Color(0xFFE0E3E8),
      _ => Colors.white,
    };

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: background,
          borderRadius: BorderRadius.circular(18),
          border: Border(left: BorderSide(color: accent, width: 5)),
          boxShadow: const <BoxShadow>[
            BoxShadow(
              color: Color.fromRGBO(24, 37, 61, 0.06),
              blurRadius: 18,
              offset: Offset(0, 10),
            ),
          ],
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Expanded(
                    child: Text(
                      stringOf(task['taskName']).isNotEmpty
                          ? stringOf(task['taskName'])
                          : '未命名任务',
                      style: const TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 14,
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Text(
                    statusText(status),
                    style: const TextStyle(
                      fontSize: 13,
                      color: Color(0xFF4A5568),
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                stringOf(task['message']).isNotEmpty
                    ? stringOf(task['message'])
                    : stringOf(task['step']).isNotEmpty
                    ? stringOf(task['step'])
                    : (live ? '等待执行' : '已完成'),
                style: const TextStyle(
                  fontSize: 12,
                  color: Color(0xFF6B7688),
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 10),
              ClipRRect(
                borderRadius: BorderRadius.circular(999),
                child: LinearProgressIndicator(
                  minHeight: 8,
                  value: progress / 100,
                  backgroundColor: const Color.fromRGBO(117, 129, 151, 0.16),
                  valueColor: AlwaysStoppedAnimation<Color>(accent),
                ),
              ),
              const SizedBox(height: 10),
              Row(
                children: <Widget>[
                  Expanded(
                    child: Text(
                      stringOf(task['userName']).isNotEmpty
                          ? stringOf(task['userName'])
                          : stringOf(task['publishMode']),
                      style: const TextStyle(
                        fontSize: 12,
                        color: Color(0xFF6B7688),
                      ),
                    ),
                  ),
                  Text(
                    '${progress.round()}%',
                    style: const TextStyle(
                      fontSize: 12,
                      color: Color(0xFF6B7688),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class QueueBatchCard extends StatelessWidget {
  const QueueBatchCard({super.key, required this.batch, required this.index});

  final JsonMap batch;
  final int index;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: const Color(0xFFD7DEE9)),
        ),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    '队列 ${index + 1}',
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '${stringOf(batch['userName']).isNotEmpty ? stringOf(batch['userName']) : '未知用户'} · ${readInt(batch, const <String>['taskCount'], 0)} 条任务',
                    style: const TextStyle(
                      fontSize: 12,
                      color: Color(0xFF6B7688),
                    ),
                  ),
                ],
              ),
            ),
            Text(
              formatDate(stringOf(batch['enqueuedAt'])),
              style: const TextStyle(fontSize: 12, color: Color(0xFF99A4B6)),
            ),
          ],
        ),
      ),
    );
  }
}

class HistoryRunCard extends StatelessWidget {
  const HistoryRunCard({super.key, required this.run});

  final JsonMap run;

  @override
  Widget build(BuildContext context) {
    final items = listOfMaps(run['items']);
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(20),
          boxShadow: const <BoxShadow>[
            BoxShadow(
              color: Color.fromRGBO(24, 37, 61, 0.05),
              blurRadius: 16,
              offset: Offset(0, 8),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    formatDate(
                      firstNonEmptyString(<String>[
                        stringOf(run['submittedAt']),
                        stringOf(run['startedAt']),
                      ]),
                    ),
                    style: const TextStyle(
                      fontSize: 12,
                      color: Color(0xFF99A4B6),
                    ),
                  ),
                ),
                Text(
                  '${items.length} 条',
                  style: const TextStyle(
                    fontSize: 12,
                    color: Color(0xFF6B7688),
                  ),
                ),
              ],
            ),
            if (stringOf(run['inputText']).isNotEmpty) ...<Widget>[
              const SizedBox(height: 10),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: const Color(0xFFEDF4FF),
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Text(
                  stringOf(run['inputText']),
                  style: const TextStyle(height: 1.6),
                ),
              ),
            ],
            if (items.isNotEmpty) ...<Widget>[
              const SizedBox(height: 12),
              ...items
                  .take(3)
                  .map(
                    (item) => Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Row(
                        children: <Widget>[
                          Expanded(
                            child: Text(
                              stringOf(item['taskName']).isNotEmpty
                                  ? stringOf(item['taskName'])
                                  : '任务',
                              style: const TextStyle(fontSize: 13),
                            ),
                          ),
                          Text(
                            statusText(stringOf(item['status'])),
                            style: const TextStyle(
                              fontSize: 12,
                              color: Color(0xFF6B7688),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
            ],
          ],
        ),
      ),
    );
  }
}

class BootView extends StatelessWidget {
  const BootView({super.key, required this.title, required this.status});

  final String title;
  final String status;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: DecoratedBox(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            colors: <Color>[Color(0xFFF9FBFE), Color(0xFFE9F0FA)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
          ),
        ),
        child: Center(
          child: Container(
            width: 420,
            padding: const EdgeInsets.all(28),
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.92),
              borderRadius: BorderRadius.circular(28),
              boxShadow: const <BoxShadow>[
                BoxShadow(
                  color: Color.fromRGBO(20, 35, 65, 0.12),
                  blurRadius: 36,
                  offset: Offset(0, 18),
                ),
              ],
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                ClipRRect(
                  borderRadius: BorderRadius.circular(22),
                  child: Image.asset(
                    'assets/app/icon.png',
                    width: 72,
                    height: 72,
                    fit: BoxFit.cover,
                  ),
                ),
                const SizedBox(height: 18),
                const SizedBox(
                  width: 42,
                  height: 42,
                  child: CircularProgressIndicator(strokeWidth: 3),
                ),
                const SizedBox(height: 22),
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 28,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 10),
                Text(
                  status,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Color(0xFF6B7688), height: 1.6),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class ErrorView extends StatelessWidget {
  const ErrorView({
    super.key,
    required this.message,
    required this.logs,
    required this.onRetry,
  });

  final String message;
  final List<String> logs;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Container(
          width: 640,
          padding: const EdgeInsets.all(24),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(26),
            boxShadow: const <BoxShadow>[
              BoxShadow(
                color: Color.fromRGBO(20, 35, 65, 0.14),
                blurRadius: 34,
                offset: Offset(0, 20),
              ),
            ],
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const Text(
                '启动失败',
                style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 12),
              Text(
                message,
                style: const TextStyle(color: Color(0xFF6B7688), height: 1.6),
              ),
              if (logs.isNotEmpty) ...<Widget>[
                const SizedBox(height: 16),
                Container(
                  width: double.infinity,
                  constraints: const BoxConstraints(maxHeight: 220),
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF5F7FB),
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: SingleChildScrollView(
                    child: Text(
                      logs.join('\n'),
                      style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 12,
                        height: 1.5,
                      ),
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 18),
              FilledButton(onPressed: onRetry, child: const Text('重试启动')),
            ],
          ),
        ),
      ),
    );
  }
}

class SettingsSectionCard extends StatelessWidget {
  const SettingsSectionCard({
    super.key,
    required this.title,
    required this.child,
  });

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFFF7F9FC),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            title,
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 14),
          child,
        ],
      ),
    );
  }
}

class SettingsTextField extends StatelessWidget {
  const SettingsTextField({
    super.key,
    required this.label,
    required this.controller,
    this.hint = '',
    this.keyboardType,
    this.obscureText = false,
    this.maxLines = 1,
  });

  final String label;
  final TextEditingController controller;
  final String hint;
  final TextInputType? keyboardType;
  final bool obscureText;
  final int maxLines;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          label,
          style: const TextStyle(fontSize: 12, color: Color(0xFF495366)),
        ),
        const SizedBox(height: 6),
        TextField(
          controller: controller,
          keyboardType: keyboardType,
          obscureText: obscureText,
          maxLines: maxLines,
          decoration: InputDecoration(
            hintText: hint,
            isDense: true,
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 12,
              vertical: 12,
            ),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
          ),
        ),
      ],
    );
  }
}

Future<void> handleWorkspaceAction(
  BuildContext context,
  AntbotController controller,
  WorkspaceAction action,
) async {
  switch (action) {
    case WorkspaceAction.renameUser:
      final nextName = await promptText(
        context,
        title: '重命名用户',
        hint: '输入新的用户名称',
        initialValue: stringOf(controller.activeUser['name']),
      );
      if (nextName == null || nextName.trim().isEmpty) {
        return;
      }
      await controller.renameCurrentUser(nextName);
      return;
    case WorkspaceAction.openSettings:
      await openSettingsDialog(context, controller);
      return;
    case WorkspaceAction.openRemote:
      await openRemoteDialog(context, controller);
      return;
    case WorkspaceAction.openVoiceClone:
      await openVoiceCloneDialog(context, controller);
      return;
    case WorkspaceAction.openLogs:
      await openLogsDialog(context, controller);
      return;
    case WorkspaceAction.refreshNow:
      await controller.refreshNow();
      return;
    case WorkspaceAction.stopTasks:
      await controller.stopTasks();
      return;
  }
}

Future<void> openSettingsDialog(
  BuildContext context,
  AntbotController controller,
) async {
  final settings = controller.visibleSettings;
  final tempDirController = TextEditingController(
    text: readString(settings, const <String>['paths', 'tempDir'], ''),
  );
  final outputDirController = TextEditingController(
    text: readString(settings, const <String>['paths', 'outputBaseDir'], ''),
  );
  final youtubePathController = TextEditingController(
    text: readString(settings, const <String>[
      'paths',
      'youtubeProjectPath',
    ], ''),
  );
  final editPathController = TextEditingController(
    text: readString(settings, const <String>['paths', 'editProjectPath'], ''),
  );
  final publishPathController = TextEditingController(
    text: readString(settings, const <String>[
      'paths',
      'publishProjectPath',
    ], ''),
  );
  final downloadCmdController = TextEditingController(
    text: readString(settings, const <String>['commands', 'download'], ''),
  );
  final geminiCmdController = TextEditingController(
    text: readString(settings, const <String>['commands', 'gemini'], ''),
  );
  final editCmdController = TextEditingController(
    text: readString(settings, const <String>['commands', 'edit'], ''),
  );
  final publishCmdController = TextEditingController(
    text: readString(settings, const <String>['commands', 'publish'], ''),
  );
  final voiceCloneCmdController = TextEditingController(
    text: readString(settings, const <String>['commands', 'voiceClone'], ''),
  );
  final geminiUrlController = TextEditingController(
    text: readString(settings, const <String>['subtitle', 'geminiUrl'], ''),
  );
  final retryController = TextEditingController(
    text:
        '${readInt(settings, const <String>['retry', 'failedTaskRetries'], 0)}',
  );
  final pauseBetweenTasksController = TextEditingController(
    text:
        '${readInt(settings, const <String>['browser', 'pauseBetweenTasksMs'], 2500)}',
  );
  final actionDelayController = TextEditingController(
    text:
        '${readInt(settings, const <String>['browser', 'actionDelayMs'], 1500)}',
  );
  final voiceSpeedController = TextEditingController(
    text: readDouble(settings, const <String>[
      'style',
      'voiceSpeed',
    ], 1.1).toStringAsFixed(1),
  );
  final subtitlePositionController = TextEditingController(
    text:
        '${readInt(settings, const <String>['style', 'subtitlePositionPercent'], 12)}',
  );
  final subtitleColorController = TextEditingController(
    text: readString(settings, const <String>[
      'style',
      'subtitleTextColor',
    ], '#FFA100'),
  );
  final strokeColorController = TextEditingController(
    text: readString(settings, const <String>[
      'style',
      'subtitleStrokeColor',
    ], '#000000'),
  );
  final voiceIdController = TextEditingController(
    text: readString(settings, const <String>['voiceClone', 'voiceId'], ''),
  );
  final modelPathController = TextEditingController(
    text: readString(settings, const <String>['voiceClone', 'modelPath'], ''),
  );
  final remotePortController = TextEditingController(
    text: '${readInt(settings, const <String>['remote', 'port'], 17888)}',
  );
  final remotePasswordController = TextEditingController(
    text: readString(settings, const <String>['remote', 'password'], ''),
  );

  final disposables = <TextEditingController>[
    tempDirController,
    outputDirController,
    youtubePathController,
    editPathController,
    publishPathController,
    downloadCmdController,
    geminiCmdController,
    editCmdController,
    publishCmdController,
    voiceCloneCmdController,
    geminiUrlController,
    retryController,
    pauseBetweenTasksController,
    actionDelayController,
    voiceSpeedController,
    subtitlePositionController,
    subtitleColorController,
    strokeColorController,
    voiceIdController,
    modelPathController,
    remotePortController,
    remotePasswordController,
  ];

  bool publishEnabled = readBool(settings, const <String>[
    'publish',
    'enabled',
  ], true);
  bool voiceoverEnabled = readBool(settings, const <String>[
    'style',
    'voiceoverEnabled',
  ], true);
  bool subtitleEnabled = readBool(settings, const <String>[
    'style',
    'subtitleEnabled',
  ], true);
  bool showAutomationWindow = readBool(settings, const <String>[
    'browser',
    'showAutomationWindow',
  ], false);
  bool remoteEnabled = readBool(settings, const <String>[
    'remote',
    'enabled',
  ], false);
  String remotePublicMode = readString(settings, const <String>[
    'remote',
    'publicMode',
  ], 'off');

  try {
    await showDialog<void>(
      context: context,
      builder: (dialogContext) {
        return StatefulBuilder(
          builder: (dialogContext, setState) {
            return AlertDialog(
              title: Row(
                children: <Widget>[
                  const Expanded(child: Text('全部设置')),
                  TextButton(
                    onPressed: () async {
                      Navigator.of(dialogContext).pop();
                      await openVoiceCloneDialog(context, controller);
                    },
                    child: const Text('语音克隆'),
                  ),
                ],
              ),
              content: SizedBox(
                width: 920,
                height: 620,
                child: Scrollbar(
                  child: SingleChildScrollView(
                    child: Column(
                      children: <Widget>[
                        SettingsSectionCard(
                          title: '工作目录',
                          child: Wrap(
                            spacing: 14,
                            runSpacing: 14,
                            children: <Widget>[
                              SizedBox(
                                width: 420,
                                child: SettingsTextField(
                                  label: '临时目录',
                                  controller: tempDirController,
                                ),
                              ),
                              SizedBox(
                                width: 420,
                                child: SettingsTextField(
                                  label: '输出目录',
                                  controller: outputDirController,
                                ),
                              ),
                              SizedBox(
                                width: 420,
                                child: SettingsTextField(
                                  label: '下载项目目录',
                                  controller: youtubePathController,
                                ),
                              ),
                              SizedBox(
                                width: 420,
                                child: SettingsTextField(
                                  label: '剪辑项目目录',
                                  controller: editPathController,
                                ),
                              ),
                              SizedBox(
                                width: 420,
                                child: SettingsTextField(
                                  label: '发布项目目录',
                                  controller: publishPathController,
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 14),
                        SettingsSectionCard(
                          title: '执行命令',
                          child: Wrap(
                            spacing: 14,
                            runSpacing: 14,
                            children: <Widget>[
                              SizedBox(
                                width: 420,
                                child: SettingsTextField(
                                  label: '下载命令',
                                  controller: downloadCmdController,
                                ),
                              ),
                              SizedBox(
                                width: 420,
                                child: SettingsTextField(
                                  label: 'Gemini 命令',
                                  controller: geminiCmdController,
                                ),
                              ),
                              SizedBox(
                                width: 420,
                                child: SettingsTextField(
                                  label: '剪辑命令',
                                  controller: editCmdController,
                                ),
                              ),
                              SizedBox(
                                width: 420,
                                child: SettingsTextField(
                                  label: '发布命令',
                                  controller: publishCmdController,
                                ),
                              ),
                              SizedBox(
                                width: 420,
                                child: SettingsTextField(
                                  label: '语音克隆命令',
                                  controller: voiceCloneCmdController,
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 14),
                        SettingsSectionCard(
                          title: '字幕与浏览器',
                          child: Column(
                            children: <Widget>[
                              Wrap(
                                spacing: 14,
                                runSpacing: 14,
                                children: <Widget>[
                                  SizedBox(
                                    width: 420,
                                    child: SettingsTextField(
                                      label: 'Gemini 字幕网址',
                                      controller: geminiUrlController,
                                    ),
                                  ),
                                  SizedBox(
                                    width: 200,
                                    child: SettingsTextField(
                                      label: '失败重试次数',
                                      controller: retryController,
                                      keyboardType: TextInputType.number,
                                    ),
                                  ),
                                  SizedBox(
                                    width: 200,
                                    child: SettingsTextField(
                                      label: '任务间隔 (ms)',
                                      controller: pauseBetweenTasksController,
                                      keyboardType: TextInputType.number,
                                    ),
                                  ),
                                  SizedBox(
                                    width: 200,
                                    child: SettingsTextField(
                                      label: '操作延迟 (ms)',
                                      controller: actionDelayController,
                                      keyboardType: TextInputType.number,
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 10),
                              SwitchListTile.adaptive(
                                contentPadding: EdgeInsets.zero,
                                title: const Text('显示自动化浏览器窗口'),
                                value: showAutomationWindow,
                                onChanged: (value) {
                                  setState(() {
                                    showAutomationWindow = value;
                                  });
                                },
                              ),
                              SwitchListTile.adaptive(
                                contentPadding: EdgeInsets.zero,
                                title: const Text('自动发布'),
                                value: publishEnabled,
                                onChanged: (value) {
                                  setState(() {
                                    publishEnabled = value;
                                  });
                                },
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 14),
                        SettingsSectionCard(
                          title: '样式与语音',
                          child: Column(
                            children: <Widget>[
                              Wrap(
                                spacing: 14,
                                runSpacing: 14,
                                children: <Widget>[
                                  SizedBox(
                                    width: 160,
                                    child: SettingsTextField(
                                      label: '语速',
                                      controller: voiceSpeedController,
                                      keyboardType:
                                          const TextInputType.numberWithOptions(
                                            decimal: true,
                                          ),
                                    ),
                                  ),
                                  SizedBox(
                                    width: 180,
                                    child: SettingsTextField(
                                      label: '字幕位置 (%)',
                                      controller: subtitlePositionController,
                                      keyboardType: TextInputType.number,
                                    ),
                                  ),
                                  SizedBox(
                                    width: 220,
                                    child: SettingsTextField(
                                      label: '字幕颜色',
                                      controller: subtitleColorController,
                                    ),
                                  ),
                                  SizedBox(
                                    width: 220,
                                    child: SettingsTextField(
                                      label: '字幕边框颜色',
                                      controller: strokeColorController,
                                    ),
                                  ),
                                  SizedBox(
                                    width: 220,
                                    child: SettingsTextField(
                                      label: '克隆音色 ID',
                                      controller: voiceIdController,
                                    ),
                                  ),
                                  SizedBox(
                                    width: 220,
                                    child: SettingsTextField(
                                      label: '克隆模型路径',
                                      controller: modelPathController,
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 10),
                              SwitchListTile.adaptive(
                                contentPadding: EdgeInsets.zero,
                                title: const Text('开启旁白语音'),
                                value: voiceoverEnabled,
                                onChanged: (value) {
                                  setState(() {
                                    voiceoverEnabled = value;
                                    if (!voiceoverEnabled) {
                                      subtitleEnabled = false;
                                    }
                                  });
                                },
                              ),
                              SwitchListTile.adaptive(
                                contentPadding: EdgeInsets.zero,
                                title: const Text('开启字幕'),
                                value: subtitleEnabled,
                                onChanged: voiceoverEnabled
                                    ? (value) {
                                        setState(() {
                                          subtitleEnabled = value;
                                        });
                                      }
                                    : null,
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 14),
                        SettingsSectionCard(
                          title: '远程服务',
                          child: Column(
                            children: <Widget>[
                              SwitchListTile.adaptive(
                                contentPadding: EdgeInsets.zero,
                                title: const Text('开启远程访问'),
                                subtitle: const Text('开启后会一并启用内网地址和公网访问。'),
                                value: remoteEnabled,
                                onChanged: (value) {
                                  setState(() {
                                    remoteEnabled = value;
                                    remotePublicMode = value
                                        ? 'cloudflare-quick'
                                        : 'off';
                                  });
                                },
                              ),
                              const SizedBox(height: 8),
                              Wrap(
                                spacing: 14,
                                runSpacing: 14,
                                children: <Widget>[
                                  SizedBox(
                                    width: 180,
                                    child: SettingsTextField(
                                      label: '端口',
                                      controller: remotePortController,
                                      keyboardType: TextInputType.number,
                                    ),
                                  ),
                                  SizedBox(
                                    width: 320,
                                    child: SettingsTextField(
                                      label: '当前用户远程密码',
                                      controller: remotePasswordController,
                                      obscureText: true,
                                    ),
                                  ),
                                  SizedBox(
                                    width: 250,
                                    child: DropdownButtonFormField<String>(
                                      initialValue: remotePublicMode,
                                      decoration: InputDecoration(
                                        labelText: '公网模式',
                                        isDense: true,
                                        border: OutlineInputBorder(
                                          borderRadius: BorderRadius.circular(
                                            12,
                                          ),
                                        ),
                                      ),
                                      items: const <DropdownMenuItem<String>>[
                                        DropdownMenuItem<String>(
                                          value: 'off',
                                          child: Text('关闭'),
                                        ),
                                        DropdownMenuItem<String>(
                                          value: 'cloudflare-quick',
                                          child: Text(
                                            'Cloudflare Quick Tunnel',
                                          ),
                                        ),
                                      ],
                                      onChanged: (value) {
                                        setState(() {
                                          remotePublicMode = value ?? 'off';
                                        });
                                      },
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              actions: <Widget>[
                TextButton(
                  onPressed: () => Navigator.of(dialogContext).pop(),
                  child: const Text('取消'),
                ),
                FilledButton(
                  onPressed: () async {
                    final patch = <String, dynamic>{
                      'paths': <String, dynamic>{
                        'tempDir': tempDirController.text.trim(),
                        'outputBaseDir': outputDirController.text.trim(),
                        'youtubeProjectPath': youtubePathController.text.trim(),
                        'editProjectPath': editPathController.text.trim(),
                        'publishProjectPath': publishPathController.text.trim(),
                      },
                      'commands': <String, dynamic>{
                        'download': downloadCmdController.text.trim(),
                        'gemini': geminiCmdController.text.trim(),
                        'edit': editCmdController.text.trim(),
                        'publish': publishCmdController.text.trim(),
                        'voiceClone': voiceCloneCmdController.text.trim(),
                      },
                      'subtitle': <String, dynamic>{
                        'geminiUrl': geminiUrlController.text.trim(),
                      },
                      'retry': <String, dynamic>{
                        'failedTaskRetries':
                            int.tryParse(retryController.text.trim()) ?? 0,
                      },
                      'publish': <String, dynamic>{'enabled': publishEnabled},
                      'browser': <String, dynamic>{
                        'pauseBetweenTasksMs':
                            int.tryParse(
                              pauseBetweenTasksController.text.trim(),
                            ) ??
                            2500,
                        'actionDelayMs':
                            int.tryParse(actionDelayController.text.trim()) ??
                            1500,
                        'showAutomationWindow': showAutomationWindow,
                      },
                      'style': <String, dynamic>{
                        'voiceSpeed':
                            double.tryParse(voiceSpeedController.text.trim()) ??
                            1.1,
                        'voiceoverEnabled': voiceoverEnabled,
                        'subtitleEnabled': voiceoverEnabled && subtitleEnabled,
                        'subtitleTextColor': subtitleColorController.text
                            .trim(),
                        'subtitleStrokeColor': strokeColorController.text
                            .trim(),
                        'subtitlePositionPercent':
                            int.tryParse(
                              subtitlePositionController.text.trim(),
                            ) ??
                            12,
                      },
                      'voiceClone': <String, dynamic>{
                        'voiceId': voiceIdController.text.trim(),
                        'modelPath': modelPathController.text.trim(),
                      },
                      'remote': <String, dynamic>{
                        'enabled': remoteEnabled,
                        'port':
                            int.tryParse(remotePortController.text.trim()) ??
                            17888,
                        'password': remotePasswordController.text.trim(),
                        'publicMode': remoteEnabled ? remotePublicMode : 'off',
                      },
                    };
                    await controller.patchSettings(patch);
                    if (dialogContext.mounted) {
                      Navigator.of(dialogContext).pop();
                    }
                  },
                  child: const Text('保存设置'),
                ),
              ],
            );
          },
        );
      },
    );
  } finally {
    for (final item in disposables) {
      item.dispose();
    }
  }
}

Future<void> openRemoteDialog(
  BuildContext context,
  AntbotController controller,
) async {
  final settings = controller.visibleSettings;
  final server = controller.server;
  final urls = listOfStrings(server['urls']);
  final publicInfo = mapOf(server['public']);
  final portController = TextEditingController(
    text: '${readInt(settings, const <String>['remote', 'port'], 17888)}',
  );
  final passwordController = TextEditingController(
    text: readString(settings, const <String>['remote', 'password'], ''),
  );
  bool remoteEnabled = readBool(settings, const <String>[
    'remote',
    'enabled',
  ], false);
  String publicMode = readString(settings, const <String>[
    'remote',
    'publicMode',
  ], 'off');

  try {
    await showDialog<void>(
      context: context,
      builder: (dialogContext) {
        return StatefulBuilder(
          builder: (dialogContext, setState) {
            return AlertDialog(
              title: const Text('远程访问'),
              content: SizedBox(
                width: 720,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      boolOf(server['online'])
                          ? '本地服务在线'
                          : (stringOf(server['lastError']).isNotEmpty
                                ? stringOf(server['lastError'])
                                : '当前未开启'),
                      style: const TextStyle(
                        fontSize: 13,
                        color: Color(0xFF495366),
                      ),
                    ),
                    const SizedBox(height: 14),
                    SettingsTextField(
                      label: '端口',
                      controller: portController,
                      keyboardType: TextInputType.number,
                    ),
                    const SizedBox(height: 14),
                    SettingsTextField(
                      label: '当前用户远程密码',
                      controller: passwordController,
                      obscureText: true,
                    ),
                    const SizedBox(height: 14),
                    DropdownButtonFormField<String>(
                      initialValue: publicMode,
                      decoration: InputDecoration(
                        labelText: '公网模式',
                        isDense: true,
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                      items: const <DropdownMenuItem<String>>[
                        DropdownMenuItem<String>(
                          value: 'off',
                          child: Text('关闭'),
                        ),
                        DropdownMenuItem<String>(
                          value: 'cloudflare-quick',
                          child: Text('Cloudflare Quick Tunnel'),
                        ),
                      ],
                      onChanged: (value) {
                        setState(() {
                          publicMode = value ?? 'off';
                        });
                      },
                    ),
                    SwitchListTile.adaptive(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('开启公网 + 内网访问'),
                      value: remoteEnabled,
                      onChanged: (value) {
                        setState(() {
                          remoteEnabled = value;
                          publicMode = value ? 'cloudflare-quick' : 'off';
                        });
                      },
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      '内网地址',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 6),
                    SelectionArea(
                      child: Text(
                        urls.isEmpty ? '未开启' : urls.join('\n'),
                        style: const TextStyle(fontSize: 12, height: 1.5),
                      ),
                    ),
                    if (urls.isNotEmpty)
                      Align(
                        alignment: Alignment.centerRight,
                        child: TextButton(
                          onPressed: () => Clipboard.setData(
                            ClipboardData(text: urls.first),
                          ),
                          child: const Text('复制内网地址'),
                        ),
                      ),
                    const SizedBox(height: 8),
                    const Text(
                      '公网地址',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 6),
                    SelectionArea(
                      child: Text(
                        stringOf(publicInfo['url']).isNotEmpty
                            ? stringOf(publicInfo['url'])
                            : (stringOf(publicInfo['lastError']).isNotEmpty
                                  ? stringOf(publicInfo['lastError'])
                                  : '未开启'),
                        style: const TextStyle(fontSize: 12, height: 1.5),
                      ),
                    ),
                    if (stringOf(publicInfo['url']).isNotEmpty)
                      Align(
                        alignment: Alignment.centerRight,
                        child: TextButton(
                          onPressed: () => Clipboard.setData(
                            ClipboardData(text: stringOf(publicInfo['url'])),
                          ),
                          child: const Text('复制公网地址'),
                        ),
                      ),
                  ],
                ),
              ),
              actions: <Widget>[
                TextButton(
                  onPressed: () => Navigator.of(dialogContext).pop(),
                  child: const Text('关闭'),
                ),
                FilledButton(
                  onPressed: () async {
                    await controller.patchSettings(<String, dynamic>{
                      'remote': <String, dynamic>{
                        'enabled': remoteEnabled,
                        'port':
                            int.tryParse(portController.text.trim()) ?? 17888,
                        'password': passwordController.text.trim(),
                        'publicMode': remoteEnabled ? publicMode : 'off',
                      },
                    });
                    if (dialogContext.mounted) {
                      Navigator.of(dialogContext).pop();
                    }
                  },
                  child: const Text('保存'),
                ),
              ],
            );
          },
        );
      },
    );
  } finally {
    portController.dispose();
    passwordController.dispose();
  }
}

Future<void> openVoiceCloneDialog(
  BuildContext context,
  AntbotController controller,
) async {
  final settings = controller.visibleSettings;
  final referenceTextController = TextEditingController(
    text: readString(settings, const <String>[
      'voiceClone',
      'referenceText',
    ], ''),
  );
  final profileNameController = TextEditingController(
    text: readString(settings, const <String>['voiceClone', 'profileName'], ''),
  );
  String language = readString(settings, const <String>[
    'voiceClone',
    'language',
  ], 'zh');
  String selectedFileName = extractFilename(
    readString(settings, const <String>['voiceClone', 'samplePath'], ''),
  );
  String sampleData = '';
  String sampleName = '';
  String formError = '';

  try {
    await showDialog<void>(
      context: context,
      builder: (dialogContext) {
        return StatefulBuilder(
          builder: (dialogContext, setState) {
            return AnimatedBuilder(
              animation: controller,
              builder: (context, _) {
                final clone = controller.voiceClone;
                final percent = readInt(clone, const <String>['percent'], 0);
                final message = readString(clone, const <String>[
                  'message',
                ], '准备中...');
                final step = readString(clone, const <String>['step'], '');
                final voiceId = readString(clone, const <String>[
                  'voiceId',
                ], '');
                final profileName = readString(clone, const <String>[
                  'profileName',
                ], '');
                final running = readBool(clone, const <String>[
                  'running',
                ], false);

                return AlertDialog(
                  title: const Text('语音克隆'),
                  content: SizedBox(
                    width: 760,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Wrap(
                          spacing: 20,
                          runSpacing: 8,
                          children: <Widget>[
                            Text(
                              '当前音色 ID：${voiceId.isNotEmpty ? voiceId : '未配置'}',
                            ),
                            Text(
                              '当前档案：${profileName.isNotEmpty ? profileName : '未配置'}',
                            ),
                          ],
                        ),
                        const SizedBox(height: 14),
                        OutlinedButton(
                          onPressed: () async {
                            final path = await pickAudioFilePath();
                            if (path == null || path.isEmpty) {
                              return;
                            }
                            final file = File(path);
                            final bytes = await file.readAsBytes();
                            final name = extractFilename(path);
                            setState(() {
                              sampleName = name;
                              selectedFileName = name;
                              sampleData =
                                  'data:${guessAudioMime(name)};base64,${base64Encode(bytes)}';
                              formError = '';
                            });
                          },
                          child: const Text('选择语音样本文件'),
                        ),
                        if (selectedFileName.isNotEmpty) ...<Widget>[
                          const SizedBox(height: 8),
                          Text(
                            selectedFileName,
                            style: const TextStyle(
                              fontSize: 12,
                              color: Color(0xFF6B7688),
                            ),
                          ),
                        ],
                        const SizedBox(height: 14),
                        SettingsTextField(
                          label: '参考文本',
                          controller: referenceTextController,
                          hint: '必须与音频内容一致',
                          maxLines: 3,
                        ),
                        const SizedBox(height: 14),
                        SettingsTextField(
                          label: '档案名称',
                          controller: profileNameController,
                          hint: '例如：蚂蚁旁白',
                        ),
                        const SizedBox(height: 14),
                        DropdownButtonFormField<String>(
                          initialValue: language,
                          decoration: InputDecoration(
                            labelText: '语言',
                            isDense: true,
                            border: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(12),
                            ),
                          ),
                          items: const <DropdownMenuItem<String>>[
                            DropdownMenuItem<String>(
                              value: 'zh',
                              child: Text('中文'),
                            ),
                            DropdownMenuItem<String>(
                              value: 'en',
                              child: Text('English'),
                            ),
                          ],
                          onChanged: (value) {
                            setState(() {
                              language = value ?? 'zh';
                            });
                          },
                        ),
                        if (formError.isNotEmpty) ...<Widget>[
                          const SizedBox(height: 10),
                          Text(
                            formError,
                            style: const TextStyle(
                              fontSize: 12,
                              color: Color(0xFFEA5154),
                            ),
                          ),
                        ],
                        const SizedBox(height: 18),
                        Text(
                          step.isNotEmpty ? step : '进度',
                          style: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 8),
                        LinearProgressIndicator(
                          value: percent <= 0 ? 0 : percent / 100,
                          minHeight: 8,
                          borderRadius: BorderRadius.circular(999),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          '$message${running ? ' ($percent%)' : ''}',
                          style: const TextStyle(
                            fontSize: 12,
                            color: Color(0xFF495366),
                            height: 1.5,
                          ),
                        ),
                      ],
                    ),
                  ),
                  actions: <Widget>[
                    TextButton(
                      onPressed: () => Navigator.of(dialogContext).pop(),
                      child: const Text('关闭'),
                    ),
                    FilledButton(
                      onPressed: controller.actionBusy
                          ? null
                          : () async {
                              if (sampleData.isEmpty) {
                                setState(() {
                                  formError = '请选择语音样本文件。';
                                });
                                return;
                              }
                              if (referenceTextController.text.trim().isEmpty) {
                                setState(() {
                                  formError = '请填写参考文本。';
                                });
                                return;
                              }
                              setState(() {
                                formError = '';
                              });
                              await controller.startVoiceClone(
                                sampleData: sampleData,
                                sampleName: sampleName.isNotEmpty
                                    ? sampleName
                                    : selectedFileName,
                                referenceText: referenceTextController.text
                                    .trim(),
                                profileName: profileNameController.text.trim(),
                                language: language,
                              );
                            },
                      child: const Text('开始语音克隆'),
                    ),
                  ],
                );
              },
            );
          },
        );
      },
    );
  } finally {
    referenceTextController.dispose();
    profileNameController.dispose();
  }
}

Future<void> openLogsDialog(
  BuildContext context,
  AntbotController controller,
) async {
  await showDialog<void>(
    context: context,
    builder: (dialogContext) {
      return AlertDialog(
        title: const Text('最近日志'),
        content: SizedBox(
          width: 780,
          height: 420,
          child: controller.logs.isEmpty
              ? const Center(
                  child: Text(
                    '暂无日志。',
                    style: TextStyle(color: Color(0xFF6B7688)),
                  ),
                )
              : ListView.separated(
                  itemCount: controller.logs.length,
                  separatorBuilder: (_, index) => const Divider(height: 18),
                  itemBuilder: (context, index) {
                    final item =
                        controller.logs[controller.logs.length - index - 1];
                    return Text(
                      '[${formatDate(stringOf(item['timestamp']))}] ${stringOf(item['message'])}',
                      style: const TextStyle(fontSize: 12, height: 1.6),
                    );
                  },
                ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('关闭'),
          ),
        ],
      );
    },
  );
}

Future<String?> promptText(
  BuildContext context, {
  required String title,
  required String hint,
  String initialValue = '',
}) async {
  final controller = TextEditingController(text: initialValue);
  final result = await showDialog<String>(
    context: context,
    builder: (context) {
      return AlertDialog(
        title: Text(title),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: InputDecoration(hintText: hint),
          onSubmitted: (value) => Navigator.of(context).pop(value),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(controller.text.trim()),
            child: const Text('确认'),
          ),
        ],
      );
    },
  );
  controller.dispose();
  return result;
}

Future<void> openLoginPreviewDialog(
  BuildContext context,
  AntbotController controller,
  String serviceKey,
) async {
  await controller.openLoginFlow(serviceKey);
  if (controller.loginPreviewDataUrl.isEmpty || !context.mounted) {
    return;
  }

  await showDialog<void>(
    context: context,
    builder: (context) {
      return AlertDialog(
        title: Text(
          controller.loginPreviewTitle.isNotEmpty
              ? controller.loginPreviewTitle
              : '登录预览',
        ),
        content: SizedBox(
          width: 780,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              if (controller.loginPreviewUrl.isNotEmpty) ...<Widget>[
                Text(
                  controller.loginPreviewUrl,
                  style: const TextStyle(
                    fontSize: 12,
                    color: Color(0xFF6B7688),
                  ),
                ),
                const SizedBox(height: 12),
              ],
              ClipRRect(
                borderRadius: BorderRadius.circular(16),
                child: Image.memory(
                  decodeDataUrl(controller.loginPreviewDataUrl),
                  fit: BoxFit.contain,
                ),
              ),
            ],
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () async {
              await controller.cancelLogin();
              if (context.mounted) {
                Navigator.of(context).pop();
              }
            },
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () async {
              await controller.confirmLogin();
              if (context.mounted) {
                Navigator.of(context).pop();
              }
            },
            child: const Text('已完成登录'),
          ),
        ],
      );
    },
  );
}

String buildStartupSummary(AntbotController controller) {
  final loginState = controller.loginState;
  final videoReady = loginReady(loginState, 'videoChannel');
  final douyinReady = loginReady(loginState, 'douyin');
  final voiceId = readString(controller.visibleSettings, const <String>[
    'voiceClone',
    'voiceId',
  ], '');
  final parts = <String>[
    '平台:${videoReady || douyinReady ? '已就绪' : '未就绪'}',
    '视频号:${videoReady ? '已登录' : '未登录'}',
    '抖音:${douyinReady ? '已登录' : '未登录'}',
    '音色:${voiceId.isNotEmpty ? voiceId : '未配置'}',
  ];
  if (controller.loadingUserId.isNotEmpty) {
    parts.add('切换中...');
  }
  return parts.join(' | ');
}

bool isDarkMode(BuildContext context) {
  return Theme.of(context).brightness == Brightness.dark;
}

Color shellCanvasColor(BuildContext context) {
  return isDarkMode(context)
      ? const Color(0xFF0F1318)
      : const Color(0xFFE3E3E5);
}

Color workspaceSurfaceColor(BuildContext context) {
  return isDarkMode(context)
      ? const Color(0xFF151A20)
      : const Color(0xFFF6F6F6);
}

Color sidebarSurfaceColor(BuildContext context) {
  return isDarkMode(context)
      ? const Color(0xFF13171D)
      : const Color(0xFFE9E9E9);
}

Color sidebarInnerColor(BuildContext context) {
  return isDarkMode(context)
      ? const Color(0xFF181D24)
      : const Color(0xFFEBEBEB);
}

Color accentHeaderColor(BuildContext context) {
  return isDarkMode(context)
      ? const Color(0xFF1E4D96)
      : const Color(0xFF2978FF);
}

Color cardSurfaceColor(BuildContext context) {
  return isDarkMode(context) ? const Color(0xFF1A2129) : Colors.white;
}

Color composerSurfaceColor(BuildContext context) {
  return isDarkMode(context)
      ? const Color(0xFF12171D)
      : const Color(0xFFF6F6F6);
}

Color inputSurfaceColor(BuildContext context) {
  return isDarkMode(context) ? const Color(0xFF191F27) : Colors.white;
}

Color subtleBorderColor(BuildContext context) {
  return isDarkMode(context)
      ? const Color(0xFF313844)
      : const Color(0xFFD6DCE5);
}

Color primaryTextColor(BuildContext context) {
  return isDarkMode(context)
      ? const Color(0xFFF5F7FA)
      : const Color(0xFF171C27);
}

Color secondaryTextColor(BuildContext context) {
  return isDarkMode(context)
      ? const Color(0xFFB9C3D0)
      : const Color(0xFF6B7688);
}

Color tertiaryTextColor(BuildContext context) {
  return isDarkMode(context)
      ? const Color(0xFF8F98A6)
      : const Color(0xFF99A4B6);
}

Color bubbleTimeColor(BuildContext context) {
  return isDarkMode(context)
      ? const Color(0xFF8F98A6)
      : const Color(0xFF99A4B6);
}

TextStyle bubbleTimeTextStyle(BuildContext context) {
  return TextStyle(fontSize: 11, color: bubbleTimeColor(context));
}

Color elevatedButtonBackground(BuildContext context, bool active) {
  if (active) {
    return isDarkMode(context)
        ? const Color(0xFF214A34)
        : const Color(0xFFE7F4EC);
  }
  return isDarkMode(context)
      ? const Color(0xFF1C232C)
      : const Color(0xFFF2F4F7);
}

Color actionButtonForeground(BuildContext context, bool active) {
  if (active) {
    return isDarkMode(context)
        ? const Color(0xFF8BD6A5)
        : const Color(0xFF2B7A4B);
  }
  return secondaryTextColor(context);
}

ButtonStyle textActionButtonStyle(
  BuildContext context, {
  required bool active,
}) {
  return TextButton.styleFrom(
    backgroundColor: elevatedButtonBackground(context, active),
    foregroundColor: actionButtonForeground(context, active),
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
  ).copyWith(
    side: WidgetStatePropertyAll<BorderSide>(
      BorderSide(color: subtleBorderColor(context)),
    ),
  );
}

Color toggleBackgroundColor(
  BuildContext context, {
  required bool active,
  required Color activeColor,
}) {
  if (active) {
    return activeColor;
  }
  return isDarkMode(context)
      ? const Color(0xFF2A3038)
      : const Color(0xFFE5E8ED);
}

Color toggleForegroundColor(BuildContext context, {required bool active}) {
  return active ? Colors.white : primaryTextColor(context);
}

String formatBubbleTime(String input) {
  if (input.isEmpty) {
    return '--:--';
  }
  final date = DateTime.tryParse(input);
  if (date == null) {
    return input;
  }
  final local = date.toLocal();
  final now = DateTime.now();
  final hh = local.hour.toString().padLeft(2, '0');
  final mm = local.minute.toString().padLeft(2, '0');
  if (local.year == now.year &&
      local.month == now.month &&
      local.day == now.day) {
    return '$hh:$mm';
  }
  final month = local.month.toString().padLeft(2, '0');
  final day = local.day.toString().padLeft(2, '0');
  return '$month-$day $hh:$mm';
}

class TaskStatusVisualTheme {
  const TaskStatusVisualTheme({
    required this.background,
    required this.border,
    required this.badge,
  });

  final Color background;
  final Color border;
  final Color badge;
}

List<JsonMap> buildConversationEntries(AntbotController controller) {
  final runs = <String, JsonMap>{};

  void mergeRun(String key, JsonMap patch) {
    final current = runs[key] ?? <String, dynamic>{'key': key, 'progress': 0.0};
    final next = <String, dynamic>{...current};

    for (final entry in patch.entries) {
      final value = entry.value;
      if (value == null) {
        continue;
      }
      if (value is String) {
        if (value.isEmpty) {
          continue;
        }
        next[entry.key] = value;
        continue;
      }
      next[entry.key] = value;
    }

    final sentAt = stringOf(patch['sentAt']);
    if (sentAt.isNotEmpty) {
      final existing = stringOf(current['sentAt']);
      if (existing.isEmpty ||
          entryTimestampMs(sentAt) < entryTimestampMs(existing)) {
        next['sentAt'] = sentAt;
      }
    }

    final statusAt = stringOf(patch['statusAt']);
    if (statusAt.isNotEmpty) {
      final existing = stringOf(current['statusAt']);
      if (existing.isEmpty ||
          entryTimestampMs(statusAt) >= entryTimestampMs(existing)) {
        next['statusAt'] = statusAt;
      }
    }

    runs[key] = next;
  }

  final optimistic = controller.optimisticChatMessages.toList(growable: false)
    ..sort(
      (left, right) => entryTimestampMs(
        stringOf(left['createdAt']),
      ).compareTo(entryTimestampMs(stringOf(right['createdAt']))),
    );
  for (final item in optimistic) {
    final runId = stringOf(item['runId']);
    final localId = stringOf(item['localId']);
    mergeRun(
      conversationRunKey(runId: runId, localId: localId),
      buildOptimisticConversationRun(item),
    );
  }

  final queueBatches = controller.queueBatches.toList(growable: false)
    ..sort(
      (left, right) => entryTimestampMs(
        stringOf(left['enqueuedAt']),
      ).compareTo(entryTimestampMs(stringOf(right['enqueuedAt']))),
    );
  for (final batch in queueBatches) {
    final runId = stringOf(batch['runId']);
    mergeRun(
      conversationRunKey(runId: runId, localId: runId),
      buildQueuedConversationRun(batch),
    );
  }

  final groupedLiveRuns = <String, List<JsonMap>>{};
  for (final task in <JsonMap>[
    ...controller.runningTasks,
    ...controller.queuedTasks,
  ]) {
    final key = conversationRunKey(
      runId: stringOf(task['batchRunId']),
      localId: stringOf(task['id']),
    );
    groupedLiveRuns.putIfAbsent(key, () => <JsonMap>[]).add(task);
  }
  final liveRuns = groupedLiveRuns.entries.toList(growable: false)
    ..sort(
      (left, right) => entryTimestampMs(
        stringOf(left.value.first['updatedAt']),
      ).compareTo(entryTimestampMs(stringOf(right.value.first['updatedAt']))),
    );
  for (final entry in liveRuns) {
    mergeRun(entry.key, buildLiveConversationRun(entry.value));
  }

  final history = controller.history.reversed.toList(growable: false);
  for (final run in history) {
    final runId = stringOf(run['id']);
    mergeRun(
      conversationRunKey(runId: runId, localId: runId),
      buildHistoryConversationRun(run),
    );
  }

  final entries = <JsonMap>[];
  final ordered = runs.values.toList(growable: false)
    ..sort((left, right) {
      final leftTime = entryTimestampMs(stringOf(left['sentAt']));
      final rightTime = entryTimestampMs(stringOf(right['sentAt']));
      return leftTime.compareTo(rightTime);
    });
  for (final run in ordered) {
    final sentAt = stringOf(run['sentAt']).isNotEmpty
        ? stringOf(run['sentAt'])
        : stringOf(run['statusAt']);
    final statusAt = stringOf(run['statusAt']).isNotEmpty
        ? stringOf(run['statusAt'])
        : sentAt;
    final inputText = stringOf(run['inputText']);
    if (inputText.isNotEmpty) {
      entries.add(<String, dynamic>{
        'kind': 'sent',
        'time': sentAt,
        'text': inputText,
      });
    }
    final title = stringOf(run['statusTitle']);
    final detail = stringOf(run['statusDetail']);
    if (title.isNotEmpty || detail.isNotEmpty) {
      entries.add(<String, dynamic>{
        'kind': 'status',
        'time': statusAt,
        'title': title,
        'detail': detail,
        'status': stringOf(run['status']),
        'progress': run['progress'] ?? 0.0,
      });
    }
  }

  return entries;
}

String conversationRunKey({required String runId, required String localId}) {
  if (runId.isNotEmpty) {
    return 'run:$runId';
  }
  return 'local:$localId';
}

JsonMap buildOptimisticConversationRun(JsonMap item) {
  final status = stringOf(item['status']).isNotEmpty
      ? stringOf(item['status'])
      : 'sending';
  final detail = stringOf(item['message']);
  return <String, dynamic>{
    'runId': stringOf(item['runId']),
    'inputText': stringOf(item['inputText']),
    'sentAt': stringOf(item['createdAt']),
    'statusAt': stringOf(item['createdAt']),
    'status': status,
    'statusTitle': switch (status) {
      'failed' => '发送失败',
      'queued' => '等待执行',
      'running' => '任务已开始',
      _ => '正在发送',
    },
    'statusDetail': detail,
    'progress': switch (status) {
      'running' => 0.18,
      'sending' => 0.08,
      _ => 0.0,
    },
  };
}

JsonMap buildQueuedConversationRun(JsonMap batch) {
  final taskCount = readInt(batch, const <String>['taskCount'], 0);
  final detail = taskCount > 0 ? '已提交 $taskCount 条任务，等待当前队列完成后执行' : '任务已进入等待队列';
  return <String, dynamic>{
    'runId': stringOf(batch['runId']),
    'inputText': stringOf(batch['inputText']).isNotEmpty
        ? stringOf(batch['inputText'])
        : buildQueueBubbleText(batch),
    'sentAt': stringOf(batch['enqueuedAt']),
    'statusAt': stringOf(batch['enqueuedAt']),
    'status': 'queued',
    'statusTitle': '等待执行',
    'statusDetail': detail,
    'progress': 0.0,
  };
}

JsonMap buildLiveConversationRun(List<JsonMap> tasks) {
  final ordered = tasks.toList(growable: false)
    ..sort(
      (left, right) =>
          entryTimestampMs(
            stringOf(left['updatedAt']).isNotEmpty
                ? stringOf(left['updatedAt'])
                : stringOf(left['enqueuedAt']),
          ).compareTo(
            entryTimestampMs(
              stringOf(right['updatedAt']).isNotEmpty
                  ? stringOf(right['updatedAt'])
                  : stringOf(right['enqueuedAt']),
            ),
          ),
    );
  final activeTask = ordered.firstWhere(
    (task) => isTaskActiveStatus(stringOf(task['status'])),
    orElse: () => ordered.isNotEmpty ? ordered.last : <String, dynamic>{},
  );
  final overallStatus = summarizeLiveRunStatus(ordered);
  final total = ordered.length;
  final completed = ordered
      .where((task) => stringOf(task['status']) == 'completed')
      .length;
  final failed = ordered.where((task) {
    final status = stringOf(task['status']);
    return status == 'failed' || status == 'partial_failed';
  }).length;
  final stopped = ordered
      .where((task) => stringOf(task['status']) == 'stopped')
      .length;
  final progress = ordered.fold<double>(
    0,
    (current, task) =>
        mathMax(current, readDouble(task, const <String>['progress'], 0) / 100),
  );
  final detailMessage = firstNonEmptyString(<String>[
    stringOf(activeTask['message']),
    stringOf(ordered.isNotEmpty ? ordered.last['message'] : ''),
  ]);

  return <String, dynamic>{
    'runId': stringOf(activeTask['batchRunId']),
    'inputText': firstNonEmptyString(
      ordered.map((task) => stringOf(task['inputText'])),
    ),
    'sentAt': firstNonEmptyString(
      ordered.map(
        (task) => stringOf(task['updatedAt']).isNotEmpty
            ? stringOf(task['updatedAt'])
            : stringOf(task['enqueuedAt']),
      ),
    ),
    'statusAt': firstNonEmptyString(
      ordered.reversed.map(
        (task) => stringOf(task['updatedAt']).isNotEmpty
            ? stringOf(task['updatedAt'])
            : stringOf(task['enqueuedAt']),
      ),
    ),
    'status': overallStatus,
    'statusTitle': switch (overallStatus) {
      'running' =>
        stringOf(activeTask['step']).isNotEmpty
            ? stringOf(activeTask['step'])
            : '正在执行',
      'failed' => '执行失败',
      'stopped' => '任务已取消',
      'completed' => '任务完成',
      _ => '等待执行',
    },
    'statusDetail': switch (overallStatus) {
      'running' => [
        if (total > 0) '已完成 $completed/$total 条',
        if (detailMessage.isNotEmpty) detailMessage,
      ].join('，'),
      'failed' =>
        detailMessage.isNotEmpty
            ? detailMessage
            : (failed > 0 ? '共有 $failed 条任务失败' : '任务执行失败'),
      'stopped' =>
        detailMessage.isNotEmpty
            ? detailMessage
            : (stopped > 0 ? '共有 $stopped 条任务已取消' : '任务已停止'),
      'completed' => total > 1 ? '共 $total 条任务已完成' : '任务已完成',
      _ =>
        detailMessage.isNotEmpty
            ? detailMessage
            : (total > 1 ? '共 $total 条任务等待执行' : '任务排队中'),
    },
    'progress': progress,
  };
}

JsonMap buildHistoryConversationRun(JsonMap run) {
  final items = listOfMaps(run['items']);
  final status = stringOf(run['status']).isNotEmpty
      ? stringOf(run['status'])
      : 'completed';
  final completed = items
      .where((item) => stringOf(item['status']) == 'completed')
      .length;
  final failed = items.where((item) {
    final current = stringOf(item['status']);
    return current == 'failed' || current == 'partial_failed';
  }).length;
  final stopped = items
      .where((item) => stringOf(item['status']) == 'stopped')
      .length;
  final firstMessage = firstNonEmptyString(
    items.map((item) => stringOf(item['message'])),
  );

  return <String, dynamic>{
    'runId': stringOf(run['id']),
    'inputText': buildRunBubbleText(run),
    'sentAt': firstNonEmptyString(<String>[
      stringOf(run['submittedAt']),
      stringOf(run['startedAt']),
      stringOf(run['endedAt']),
    ]),
    'statusAt': firstNonEmptyString(<String>[
      stringOf(run['endedAt']),
      stringOf(run['startedAt']),
    ]),
    'status': status,
    'statusTitle': switch (status) {
      'partial_failed' => '部分失败',
      'failed' => '任务失败',
      'stopped' => '任务已取消',
      _ => '任务完成',
    },
    'statusDetail': switch (status) {
      'partial_failed' =>
        '完成 $completed 条，失败 $failed 条${firstMessage.isNotEmpty ? '，$firstMessage' : ''}',
      'failed' => firstMessage.isNotEmpty ? firstMessage : '任务未能成功执行',
      'stopped' => stopped > 0 ? '已取消 $stopped 条任务' : '任务已停止',
      _ => items.isNotEmpty ? '共 ${items.length} 条任务已完成' : '任务已完成',
    },
    'progress': status == 'completed' ? 1.0 : 0.0,
  };
}

String summarizeLiveRunStatus(List<JsonMap> tasks) {
  if (tasks.any((task) => stringOf(task['status']) == 'running')) {
    return 'running';
  }
  if (tasks.any((task) {
    final status = stringOf(task['status']);
    return status == 'queued' || status == 'pending';
  })) {
    return 'queued';
  }
  if (tasks.any((task) {
    final status = stringOf(task['status']);
    return status == 'failed' || status == 'partial_failed';
  })) {
    return 'failed';
  }
  if (tasks.any((task) => stringOf(task['status']) == 'stopped')) {
    return 'stopped';
  }
  if (tasks.any((task) => stringOf(task['status']) == 'completed')) {
    return 'completed';
  }
  return 'queued';
}

TaskStatusVisualTheme taskStatusTheme(BuildContext context, String status) {
  final dark = isDarkMode(context);
  switch (status) {
    case 'completed':
      return TaskStatusVisualTheme(
        background: dark ? const Color(0xFF173124) : const Color(0xFFF0FAF4),
        border: dark ? const Color(0xFF29523A) : const Color(0xFFD3E9DA),
        badge: const Color(0xFF45AB6A),
      );
    case 'failed':
    case 'partial_failed':
      return TaskStatusVisualTheme(
        background: dark ? const Color(0xFF351B1C) : const Color(0xFFFFF2F2),
        border: dark ? const Color(0xFF5A2B2D) : const Color(0xFFF1D0D1),
        badge: const Color(0xFFEA5154),
      );
    case 'stopped':
      return TaskStatusVisualTheme(
        background: dark ? const Color(0xFF242A31) : const Color(0xFFF3F4F6),
        border: dark ? const Color(0xFF39414C) : const Color(0xFFD9DCE2),
        badge: const Color(0xFF8C95A3),
      );
    case 'running':
      return TaskStatusVisualTheme(
        background: dark ? const Color(0xFF16273D) : const Color(0xFFF3F8FF),
        border: dark ? const Color(0xFF244364) : const Color(0xFFD7E6FF),
        badge: const Color(0xFF2978FF),
      );
    case 'sending':
      return TaskStatusVisualTheme(
        background: dark ? const Color(0xFF15212D) : const Color(0xFFF7FAFF),
        border: dark ? const Color(0xFF244364) : const Color(0xFFD7E6FF),
        badge: const Color(0xFF2978FF),
      );
    default:
      return TaskStatusVisualTheme(
        background: dark ? const Color(0xFF302718) : const Color(0xFFFFF9EF),
        border: dark ? const Color(0xFF56462B) : const Color(0xFFF1DFC2),
        badge: const Color(0xFFEEAB1C),
      );
  }
}

String taskStatusLabel(String status) {
  switch (status) {
    case 'completed':
      return '完成';
    case 'failed':
      return '失败';
    case 'partial_failed':
      return '部分失败';
    case 'stopped':
      return '已取消';
    case 'running':
      return '执行中';
    case 'sending':
      return '发送中';
    default:
      return '等待中';
  }
}

bool isTaskActiveStatus(String status) {
  return status == 'queued' || status == 'pending' || status == 'running';
}

int entryTimestampMs(String input) {
  final date = DateTime.tryParse(input);
  return date?.millisecondsSinceEpoch ?? 0;
}

String firstNonEmptyString(Iterable<String> values) {
  for (final value in values) {
    if (value.trim().isNotEmpty) {
      return value.trim();
    }
  }
  return '';
}

double mathMax(double left, double right) {
  return left >= right ? left : right;
}

String buildRunBubbleText(JsonMap run) {
  final inputText = stringOf(run['inputText']);
  if (inputText.isNotEmpty) {
    return inputText;
  }

  final lines = listOfMaps(run['items'])
      .map((item) {
        final title = stringOf(item['publishMode']).isNotEmpty
            ? stringOf(item['publishMode'])
            : stringOf(item['taskName']);
        final url = stringOf(item['videoUrl']).isNotEmpty
            ? stringOf(item['videoUrl'])
            : (stringOf(item['sourceUrl']).isNotEmpty
                  ? stringOf(item['sourceUrl'])
                  : stringOf(item['url']));
        if (title.isNotEmpty && url.isNotEmpty) {
          return '$title，$url';
        }
        return title.isNotEmpty ? title : url;
      })
      .where((line) => line.trim().isNotEmpty)
      .take(5)
      .toList(growable: false);

  return lines.join('\n');
}

String buildQueueBubbleText(JsonMap batch) {
  final inputText = stringOf(batch['inputText']);
  if (inputText.isNotEmpty) {
    return inputText;
  }

  final itemLines = listOfMaps(batch['items'])
      .map(
        (item) => stringOf(item['taskName']).isNotEmpty
            ? stringOf(item['taskName'])
            : stringOf(item['url']),
      )
      .where((line) => line.trim().isNotEmpty)
      .take(4)
      .toList(growable: false);
  if (itemLines.isNotEmpty) {
    return itemLines.join('\n');
  }

  final taskCount = readInt(batch, const <String>['taskCount'], 0);
  final userName = stringOf(batch['userName']);
  if (userName.isNotEmpty && taskCount > 0) {
    return '$userName，待执行 $taskCount 条任务';
  }
  if (taskCount > 0) {
    return '待执行 $taskCount 条任务';
  }
  return '任务已进入排队区';
}

String buildTaskStripTitle(JsonMap task, int sequence) {
  final title = stringOf(task['taskName']).isNotEmpty
      ? stringOf(task['taskName'])
      : '任务$sequence';
  final message = stringOf(
    task['message'],
  ).replaceAll(RegExp(r'\s+'), ' ').trim();
  if (message.isEmpty) {
    return '$title：';
  }
  if (message.startsWith(title)) {
    return message;
  }
  return '$title：$message';
}

String buildTaskStripStatus(String status, JsonMap task) {
  switch (status) {
    case 'completed':
      return '完成';
    case 'failed':
    case 'partial_failed':
      return '失败';
    case 'stopped':
      return '已取消';
    case 'running':
      return stringOf(task['step']).isNotEmpty
          ? stringOf(task['step'])
          : '首次执行';
    case 'queued':
    case 'pending':
      return '等待';
    default:
      return statusText(status);
  }
}

String formatFigmaDate(String input) {
  if (input.isEmpty) {
    return '';
  }
  final date = DateTime.tryParse(input);
  if (date == null) {
    return '';
  }
  final local = date.toLocal();
  final hh = local.hour.toString().padLeft(2, '0');
  final mm = local.minute.toString().padLeft(2, '0');
  return '${local.month}月${local.day}日 $hh:$mm';
}

String extractFilename(String input) {
  if (input.isEmpty) {
    return '';
  }
  final normalized = input.replaceAll('\\', '/');
  final index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.substring(index + 1) : normalized;
}

String guessAudioMime(String fileName) {
  final lower = fileName.toLowerCase();
  if (lower.endsWith('.mp3')) {
    return 'audio/mpeg';
  }
  if (lower.endsWith('.wav')) {
    return 'audio/wav';
  }
  if (lower.endsWith('.m4a')) {
    return 'audio/x-m4a';
  }
  if (lower.endsWith('.aac')) {
    return 'audio/aac';
  }
  if (lower.endsWith('.ogg')) {
    return 'audio/ogg';
  }
  if (lower.endsWith('.flac')) {
    return 'audio/flac';
  }
  if (lower.endsWith('.webm')) {
    return 'audio/webm';
  }
  return 'audio/wav';
}

Future<String?> pickAudioFilePath() async {
  if (!Platform.isMacOS) {
    return null;
  }

  final result = await Process.run('osascript', <String>[
    '-e',
    'set selectedFile to choose file with prompt "选择语音样本文件"',
    '-e',
    'POSIX path of selectedFile',
  ]);

  if (result.exitCode != 0) {
    return null;
  }

  final path = stringOf(result.stdout);
  return path.isEmpty ? null : path;
}

bool loginReady(JsonMap loginState, String key) {
  return boolOf(mapOf(loginState[key])['loggedIn']);
}

String statusText(String status) {
  switch (status) {
    case 'queued':
    case 'pending':
      return '等待';
    case 'running':
      return '执行中';
    case 'completed':
      return '完成';
    case 'failed':
      return '失败';
    case 'stopped':
      return '已停止';
    case 'partial_failed':
      return '部分失败';
    default:
      return status.isEmpty ? '空闲' : status;
  }
}

String formatDate(String input) {
  if (input.isEmpty) {
    return '--';
  }
  final date = DateTime.tryParse(input);
  if (date == null) {
    return input;
  }
  final local = date.toLocal();
  final mm = local.month.toString().padLeft(2, '0');
  final dd = local.day.toString().padLeft(2, '0');
  final hh = local.hour.toString().padLeft(2, '0');
  final min = local.minute.toString().padLeft(2, '0');
  return '$mm-$dd $hh:$min';
}

JsonMap mapOf(dynamic value) {
  if (value is Map<String, dynamic>) {
    return value;
  }
  if (value is Map) {
    return value.map((key, dynamic nested) => MapEntry(key.toString(), nested));
  }
  return <String, dynamic>{};
}

List<JsonMap> listOfMaps(dynamic value) {
  if (value is! List) {
    return const <JsonMap>[];
  }
  return value.map((item) => mapOf(item)).toList(growable: false);
}

List<String> listOfStrings(dynamic value) {
  if (value is! List) {
    return const <String>[];
  }
  return value.map((item) => item.toString()).toList(growable: false);
}

String stringOf(dynamic value) {
  if (value == null) {
    return '';
  }
  return value is String ? value.trim() : value.toString().trim();
}

bool boolOf(dynamic value, [bool fallback = false]) {
  if (value is bool) {
    return value;
  }
  if (value is num) {
    return value != 0;
  }
  final text = stringOf(value).toLowerCase();
  if (text.isEmpty) {
    return fallback;
  }
  if (<String>['1', 'true', 'yes', 'on', 'enabled'].contains(text)) {
    return true;
  }
  if (<String>['0', 'false', 'no', 'off', 'disabled'].contains(text)) {
    return false;
  }
  return fallback;
}

int readInt(JsonMap root, List<String> path, int fallback) {
  final value = readPath(root, path);
  if (value is int) {
    return value;
  }
  if (value is double) {
    return value.round();
  }
  return int.tryParse(stringOf(value)) ?? fallback;
}

double readDouble(JsonMap root, List<String> path, double fallback) {
  final value = readPath(root, path);
  if (value is double) {
    return value;
  }
  if (value is int) {
    return value.toDouble();
  }
  return double.tryParse(stringOf(value)) ?? fallback;
}

bool readBool(JsonMap root, List<String> path, bool fallback) {
  return boolOf(readPath(root, path), fallback);
}

String readString(JsonMap root, List<String> path, String fallback) {
  final value = stringOf(readPath(root, path));
  return value.isEmpty ? fallback : value;
}

dynamic readPath(JsonMap root, List<String> path) {
  dynamic current = root;
  for (final key in path) {
    if (current is Map && current.containsKey(key)) {
      current = current[key];
    } else {
      return null;
    }
  }
  return current;
}

Color parseHexColor(String input) {
  final normalized = input.replaceAll('#', '').trim();
  if (normalized.length != 6) {
    return const Color(0xFF000000);
  }
  return Color(int.parse('FF$normalized', radix: 16));
}

String colorToHex(Color color) {
  final red = (color.r * 255.0)
      .round()
      .clamp(0, 255)
      .toRadixString(16)
      .padLeft(2, '0');
  final green = (color.g * 255.0)
      .round()
      .clamp(0, 255)
      .toRadixString(16)
      .padLeft(2, '0');
  final blue = (color.b * 255.0)
      .round()
      .clamp(0, 255)
      .toRadixString(16)
      .padLeft(2, '0');
  return '#${red.toUpperCase()}${green.toUpperCase()}${blue.toUpperCase()}';
}

Uint8List decodeDataUrl(String value) {
  final comma = value.indexOf(',');
  final source = comma >= 0 ? value.substring(comma + 1) : value;
  return base64Decode(source);
}

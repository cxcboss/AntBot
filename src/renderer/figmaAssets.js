function asset(path) {
  return new URL(path, import.meta.url).href;
}

export const FIGMA_ASSETS = {
  avatars: {
    1: asset('./assets/figma/avatar-1.png'),
    2: asset('./assets/figma/avatar-2.png'),
    3: asset('./assets/figma/avatar-3.png'),
    4: asset('./assets/figma/avatar-4.png'),
    5: asset('./assets/figma/avatar-5.png')
  },
  icons: {
    settings: asset('./assets/figma/icon-settings.svg'),
    remote: asset('./assets/figma/icon-remote.svg'),
    send: asset('./assets/figma/icon-send.svg'),
    more: asset('./assets/figma/icon-more.svg'),
    douyinOn: asset('./assets/figma/icon-douyin-on.svg'),
    douyinOff: asset('./assets/figma/icon-douyin-off.svg'),
    videoOn: asset('./assets/figma/icon-video-on.svg'),
    videoOff: asset('./assets/figma/icon-video-off.svg'),
    taskFailed: asset('./assets/figma/icon-task-failed.svg'),
    taskStopped: asset('./assets/figma/icon-task-stopped.svg')
  }
};

import { initPreferences, updatePreferences } from '@vben/preferences';
import { unmountGlobalLoading } from '@vben/utils';

import { overridesPreferences, preferencesExtension } from './preferences';

/**
 * 应用初始化完成之后再进行页面加载渲染
 */
async function initApplication() {
  // name用于指定项目唯一标识
  // 用于区分不同项目的偏好设置以及存储数据的key前缀以及其他一些需要隔离的数据
  const env = import.meta.env.PROD ? 'prod' : 'dev';
  const appVersion = import.meta.env.VITE_APP_VERSION;
  const namespace = `${import.meta.env.VITE_APP_NAMESPACE}-${appVersion}-${env}`;

  // app偏好设置初始化
  await initPreferences({
    extension: preferencesExtension,
    namespace,
    overrides: overridesPreferences,
  });

  // 首页路径是产品配置不是用户偏好：initPreferences 让浏览器缓存的旧值盖过 overrides，
  // 改版前缓存的 /finance 会让守卫把冷加载的 /finance 当成"默认首页"换到 homePath，深链落空。
  // 这里用 overrides 钉回，并随后写回缓存。
  const pinnedHome = overridesPreferences.app?.defaultHomePath;
  if (pinnedHome) {
    updatePreferences({ app: { defaultHomePath: pinnedHome } });
  }

  // 启动应用并挂载
  // vue应用主要逻辑及视图
  const { bootstrap } = await import('./bootstrap');
  await bootstrap(namespace);

  // 移除并销毁loading
  unmountGlobalLoading();
}

initApplication();

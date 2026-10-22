// 系统版本（根目录 package.json，构建时注入）。改动记录见 CHANGELOG.md，界面里「更多 → 更新内容」
declare const __APP_VERSION__: string
export const APP_VERSION: string = __APP_VERSION__

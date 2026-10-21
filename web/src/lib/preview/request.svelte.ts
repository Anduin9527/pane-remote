// 别的地方（阅读模式里的链接、电脑要打开的网页、推送）要求在预览里打开某个地址：打开预览插件（#/plugin/preview），PreviewView 连上后打开它
// handled：预览已经处理到第几个（预览睡眠后重新载入也不会把处理过的再开一遍）
export const previewRequest = $state({ url: '', n: 0, handled: 0 })
export function openInPreview(url: string) {
  previewRequest.url = url
  previewRequest.n++
}

// 预览全屏：隐藏 App 顶栏和预览自己的地址栏、输入栏（横屏看电脑模式时用）
export const previewUi = $state({ immersive: false })

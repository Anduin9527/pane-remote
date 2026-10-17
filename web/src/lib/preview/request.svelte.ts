// 别的地方（阅读模式里的链接等）要求在预览里打开某个地址：App 切到预览页，PreviewView 连上后打开它
export const previewRequest = $state({ url: '', n: 0 })
export function openInPreview(url: string) {
  previewRequest.url = url
  previewRequest.n++
}

// 预览全屏：隐藏 App 顶栏和预览自己的地址栏、输入栏（横屏看电脑模式时用）
export const previewUi = $state({ immersive: false })

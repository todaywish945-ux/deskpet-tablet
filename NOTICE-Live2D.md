# 第三方组件说明（assets/vendor）

| 文件 | 项目 | 许可 |
|---|---|---|
| `pixi.min.js` | [PixiJS](https://pixijs.com/) | MIT |
| `index.min.js` | [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) | MIT |
| `live2dcubismcore.min.js` | Live2D Cubism Core SDK | **Live2D 专有许可**（非 MIT） |

`live2dcubismcore.min.js` 是 Live2D Inc. 的专有运行时，按 [Live2D Cubism SDK 发布许可](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_cn.html)
条款随本仓库再分发：个人及符合其条件的小规模使用免费，具体权利义务以 Live2D 官方条款为准。
**本仓库的 MIT 许可不覆盖该文件。**

只使用视频（`backend: "video"`）皮肤的话，可以整个删除 `assets/vendor/` 目录。

# 敲敲 · 开发约定

## 改完必做（发版前同样跑一遍）

```bash
npm run typecheck
npm run build
npm run verify:ui
```

`verify:ui` 会用临时配置目录启动一个真实实例（不碰 `%APPDATA%\ye-shunguang-deskpet`），自动检查：

- 系统视频叠加层开关（透明窗口四角闪/黑的根因）
- 平板缩放 1.1465、灵动岛缩放 1
- `--screen-radius` 变量、屏幕/动画层/视频三处圆角、动画层 overflow
- 主界面和视频通话界面的四角像素透明
- 桌面实拍：圆角外无画面泄漏、窗口确实置顶显示

页面截图看不到系统合成层的问题，涉及窗口透明/视频/圆角的验收以 `verify:ui` 的桌面实拍和真机人眼为准。

## 不能随手删的三处约定

- 主进程 `disable-direct-composition-video-overlays`：系统视频叠加层会绕过页面圆角裁剪
- 圆角唯一来源 `--screen-radius`（style.css `:root`）：`#screen`、`#char-layer`、`#char-layer video` 全部引用它，不许各写各的数值
- `#char-layer` 的 `opacity: 0.999` + 圆角裁剪：阻止 video 被提升为硬件叠加层

## 手动验收（自动化覆盖不了）

- 主界面和通话界面都能看到人物视频（不是只剩一层暗色壁纸）
- 连续两轮说话，**不重载页面**，每轮都有说话动画（入场过渡 / 说话循环 / 回待机）
- 说话入场过渡期间点一下屏幕，再发一条，下一轮仍要有说话动画（防状态机卡死）
- 最小化到灵动岛再唤回平板，动画和声音都正常

## 新增角色（皮肤）

- 目录 `assets/skins/<id>/`，结构对照 `yeshunguang`：`skin.json`、`animations/manifest.json`、`avatar.png`、`wallpaper`、`prompts/character.md`；Live2D 后端仍受支持，但项目不再内置 Live2D 示例皮肤
- 角色只放资源和 manifest，不要给单个角色另写全屏视频/圆角样式（四角约定是全局的）
- `manifest.json` 的 talk 列表、transitions、settle 可缺省；缺少过渡时状态机会直接切说话循环，不要依赖某个角色一定有过渡片
- 合入前：`npm run verify:ui` + 真机开一轮视频通话，连续两轮说话有动画、通话界面四角无黑块/闪烁

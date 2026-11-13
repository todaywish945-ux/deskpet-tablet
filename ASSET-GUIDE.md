# 素材指南（ASSET-GUIDE）

框架的一切角色表现都组织在**皮肤包**里：人设、动画、贴纸、头像、语音参考。
本文说明每种素材的位置、格式与行为。所有路径相对皮肤目录（内置皮肤在 `assets/skins/<id>/`，
用户自装皮肤在 `%APPDATA%/deskpet-tablet/skins/<id>/`——**优先级更高，升级框架不丢失**）。

## 皮肤包结构

```
<皮肤id>/
  skin.json              皮肤清单（唯一必需文件，框架靠它识别皮肤）
  avatar.png             头像（会话列表 / 灵动岛 / 内嵌面板）
  prompts/character.md   人设 = 对话系统提示词全文
  animations/            视频后端：动作切片 + manifest.json + loop-points.json
  stickers/              贴纸 + reactions.json（情绪→贴纸，也是占位模式的兜底图）
  wallpapers/            主界面壁纸（可选，视频背景烤入方案用）
  model/                 Live2D 后端：模型目录
```

## skin.json 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 皮肤标识，**必须与文件夹同名** |
| `name` | string | 设置下拉里显示的名字 |
| `backend` | `"video"` \| `"live2d"` | 渲染方式，二者选一 |
| `manifest` | string | 视频后端：动画清单路径，如 `animations/manifest.json`；**文件不存在时自动进入贴纸占位模式** |
| `loopPoints` | string | 无缝循环点表路径（可选） |
| `reactions` | string | 情绪→贴纸映射路径（可选） |
| `model` | string | Live2D 后端：模型入口，如 `model/xxx.model3.json` |
| `emotions` | object | Live2D 后端：情绪→**表情名**映射（如 `{"shy": "脸红"}`）；视频后端留 `{}` |
| `avatar` | string | 头像路径 |
| `wallpaper` / `tray` | string | 壁纸 / 托盘图标（可选） |
| `persona` | string | 人设路径（必填） |

## 人设（prompts/character.md）

模板目录已内置一个开箱即用的通用人设「阿板」（`assets/skins/template/prompts/character.md`）；
想换成你自己的角色，按同目录 `TEMPLATE-GUIDE.md` 填好后覆盖它。要点：

1. **身份直给**：以「你」描述她本人（"你是……"），不要写"你要扮演"
2. **说话风格给例句**：口头禅 + 三句不同场景的例句，比形容词有效得多
3. **必须保留情绪协议段**：要求她每条回复末行输出 `[emotion:情绪名]`，框架解析后驱动表情并在气泡里剥离标签。24 个合法情绪：
   `neutral, listen, comfort, encourage, celebrate, thanks, affection, shy, moved, playful, morning, night, welcome, apology, thinking, curious, sleepy, sad, agree, care, rest, tired, patience, reassure`

## 视频动画（backend: "video"）

把动作切片放进 `animations/`，写 `manifest.json`：

```json
{
  "idle": ["idle_01.mp4", "idle_02.mp4"],
  "talk": "talk_standby.mp4",
  "emotions": {
    "celebrate": "emo_celebrate.mp4",
    "shy": "emo_shy.mp4"
  },
  "settle": { "talk_standby.mp4": "settle_standby.mp4" }
}
```

规则（与 `AnimationPlayer` 行为一一对应）：

- **idle**（必填才启用视频模式）：待机循环，单字符串或数组；点击平板屏幕切到数组下一段
- **talk**（可选）：说话循环，说完回待机；没有就保持 idle
- **emotions**（可选）：回复的情绪标签命中时播一遍，播完自动回落；没映射的情绪沿用说话/待机画面
- **settle**（可选，进阶）：说话片段 → 收势片段映射，收势须从源视频"紧接说话片段出点"处剪出
- **loop-points.json**（可选）：`{ "idle_01.mp4": { "loopIn": 1.4, "loopOut": 13.4 } }`（秒），
  播放器循环时在两帧间跳转实现无缝循环。可用 `scripts/loop-points.mjs` 自动计算（需 ffmpeg 在 PATH），
  也可手写
- **情绪→说话风格**：当 talk 列表里存在这四个文件名时启用按情绪换说话姿态——
  `talk_04_loop.mp4`（热闹）/ `talk_face.mp4`（害羞）/ `talk_squint.mp4`（温柔）/ `talk_standby.mp4`（平静）。
  用别的命名也能跑，只是不区分说话风格

画面方案二选一：

- **A. 背景烤入**：普通 mp4（H.264 即可），画面里带背景，配合 `wallpapers/` 主界面壁纸使边框融入——实现最简单，兼容性最好
- **B. 真透明**：WebM/VP9 带 Alpha 通道，无壁纸也自然

## 贴纸（占位模式 + 情绪兜底）

- `stickers/placeholder-idle.png`、`placeholder-talk.png`：**没有 manifest 时占位模式显示的待机/说话图**，模板已带，可换成你角色的立绘差分
- `stickers/reactions.json`：`{ "celebrate": "celebrate.png", ... }`（相对 stickers/），
  视频模式下情绪片段缺失时兜底显示，Live2D 模式同理

## Live2D 模型（backend: "live2d"）

- `model/` 放整套 Cubism 模型（`.model3.json`、贴图、动作、表情 `.exp3.json`）
- `skin.json` 的 `model` 指向 `.model3.json`
- `emotions` 把 24 个情绪名映射到**模型里的表情名**（即 exp 文件注册的名称）：
  `"emotions": { "shy": "脸红", "celebrate": "＞＜" }`
- 运行时依赖 `assets/vendor/`（见 NOTICE-Live2D.md）

## 头像 / 壁纸 / 托盘

- `avatar.png`：正方形即可，会话列表、灵动岛、内嵌面板共用
- `wallpapers/` + `skin.json.wallpaper`：主界面背景（方案 A 必配）
- `tray`：托盘图标（可选，缺省用内置图标）

## 语音素材

- **百炼在线克隆**：单人清晰人声、无背景噪音，建议 10 秒以上；覆盖为
  `assets/voice/reference.mp3` 后运行 `node scripts/enroll-and-test.mjs`
- **本地 GPT-SoVITS**：3~10 秒清晰人声 + **逐字**一致的文本；模型训练在整合包 WebUI 里完成，
  框架只调用 api_v2（设置里填整合包路径，**路径不要含中文**）
- 只克隆你有权使用的声音

## 验收清单

- [ ] `skin.json` 的 `id` = 文件夹名，`backend` 与素材匹配
- [ ] `persona` 指向的文件存在，且含情绪协议段
- [ ] manifest 引用的每个视频文件都存在（或干脆不放 manifest → 占位模式）
- [ ] 设置窗口的皮肤下拉能看到新皮肤，选中重启后生效
- [ ] 发一条消息：气泡出字 → 有声音 → 表情/动画按情绪切换

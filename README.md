# 平板桌宠框架（deskpet-tablet）

一台摆在桌面上的平板，你的 AI 角色「住」在里面——像一通一直没挂断的视频通话。
打字或开口说话，她会思考、做出表情、用克隆的声音回应你。

> **本仓库只包含框架，不含任何角色素材。** 角色动画、人设、语音三样东西由你自己准备
> （见下方「三样自备素材」）。你放入的素材版权归原权利人，请自用、勿随框架再分发。

## 功能特性

- **平板形态**：窗口沉底（藏在所有应用窗口之下，点击平板浮起）或置顶两种层级；抓住边框拖动；托盘常驻
- **双视图**：主界面（话题选择、历史会话）⇄ 视频通话界面；挂断自动存为一个会话，随时接着聊
- **AI 对话**：任意 OpenAI 兼容接口（默认智谱 GLM），流式回复 + 打字机气泡；多会话上下文
- **情绪系统**：模型在回复末行输出 `[emotion:xxx]` 标签，框架解析后驱动表情/动画切换（24 种情绪，解析带容错）
- **语音双引擎**：阿里云百炼在线克隆音色（WebSocket 流式合成，边合成边播）或本地 GPT-SoVITS（api_v2 服务自动拉起）
- **语音输入**：MediaRecorder 录音 → 重采样 16kHz WAV → 智谱 GLM-ASR 转文字直接发送
- **档案记忆**：对话静默 20 秒后台提取「关于你的事」，跨会话共享、每轮自然引用；设置里可查看删除
- **灵动岛**：失焦收成屏幕顶部胶囊；胶囊 ⇄ 展开卡片 ⇄ 贴边细条，弹簧动效，绝不抢焦点
- **外部控制桥**：本地 HTTP/WS（127.0.0.1:37820）直出控制 API 与 `pet:*` 事件流，外部程序/agent 可指挥她说话、做表情、接通视频
- **空素材可跑**：没有动画/贴纸素材时自动进入贴纸占位模式，对话、语音、情绪流程照常

## 三样自备素材

| 素材 | 是什么 | 文档 |
|---|---|---|
| 人设 | 一份系统提示词文本（模板已内置） | [ASSET-GUIDE.md](ASSET-GUIDE.md) §人设 |
| 形象动画 | 透明视频切片，或 Live2D 模型 | [ASSET-GUIDE.md](ASSET-GUIDE.md) §动画 / §Live2D |
| 语音 | 一段参考音频（在线克隆），或本地训练的模型 | [ASSET-GUIDE.md](ASSET-GUIDE.md) §语音 |

## 快速开始

```bash
npm install
npm run dev        # 开发模式启动
npm run dist       # 打包 Windows 安装包（NSIS → dist_app/）
```

首次使用：

1. **对话**：设置里填智谱 API Key（或 `setx ZHIPU_API_KEY`，框架自动读取）
2. **声音**：参考音频放 `assets/voice/reference.mp3` → `setx DASHSCOPE_API_KEY` → `node scripts/enroll-and-test.mjs`（一次性，自动写入配置）
3. **形象与人设**：复制 `assets/skins/template` 为你的皮肤，填入人设与素材，设置里选择
4. 回到平板，开始聊天

不想动手？把 [AUTOSETUP.md](AUTOSETUP.md) 里的总控指令整段发给会操作电脑的
AI 智能体（例如百度搭子桌面端）：它自己下载框架、装环境、配密钥、启动验收——
最少只需填一个智谱 Key，断了发「继续」接着跑；
需要分步控制或排障时再用 [PROMPTS-FOR-DUMATE.md](PROMPTS-FOR-DUMATE.md) 的指令卡。

配置存于 `%APPDATA%/deskpet-tablet/data/config.json`，会话在同目录 `sessions.json`。

## 语音引擎怎么选

| | 百炼在线克隆（默认） | GPT-SoVITS 本地 |
|---|---|---|
| 费用 | 按量计费（欠费即哑） | **完全免费**，无限量 |
| 门槛 | 注册百炼 + 一段参考音频（≥10 秒） | 英伟达显卡 N卡（建议 6GB+ 显存）+ 10GB 整合包 |
| 配置难度 | ★ 全自动可配 | ★★★ 需自备整合包、配置路径 |
| 音色 | 像参考音频，开箱稳定 | 零样本即可用（3~10 秒参考音频）；自训后更稳更像 |
| 断网 | 没声音 | 照常说话 |
| 资源占用 | 无 | 服务常驻显存约 3GB（与游戏抢显存时合成变慢） |

想省事或没有 N卡 → 百炼；重度使用、零成本、有 N卡 → 本地。先用百炼跑通、之后在
设置或配置文件里切 `provider: "gptsovits"` 也完全可以（详见 [ASSET-GUIDE.md](ASSET-GUIDE.md) §语音）。

## 项目结构

```
src/main/                Electron 主进程
  petWindow.ts           平板窗口（透明/拖动/层级 koffi SetWindowPos）
  islandWindow.ts        灵动岛窗口（胶囊/卡片/贴边三形态，弹簧补间）
  tray.ts / settingsWindow.ts / ipc.ts
  services/
    llm.ts               OpenAI 兼容流式客户端 + 人设加载
    tts.ts               百炼 WebSocket 流式合成（PCM 24kHz）
    gsv.ts               GPT-SoVITS 本地服务自动拉起
    enrollment.ts        百炼音色注册（OSS 上传 + create_voice）
    chatPipeline.ts      对话流水线：流式 → 分句 → 合成 → 情绪 → 会话落盘
    profile.ts / memory.ts / mood.ts / proactive.ts
                         档案记忆 / 记忆 / 情绪 / 主动开口
    pluginBridge.ts      本地控制桥（HTTP/WS + /panel 面板页 + pet:* 事件流）
    panelPage.ts         内嵌通话面板页（iframe 同屏方案）
    petEvents.ts         事件总线（chatPipeline → 控制桥的分接点）
    sessionState.ts / store.ts
                         会话状态 / 配置·皮肤·持久化
src/preload/             contextBridge API
src/renderer/pet/        平板 UI（AnimationPlayer 视频状态机 / Live2DPlayer / PcmPlayer）
src/renderer/island/     灵动岛渲染层
src/renderer/settings/   设置页
scripts/                 enroll-and-test.mjs 音色注册；loop-points.mjs 循环点计算（需 ffmpeg）
assets/skins/template/   模板皮肤（空骨架，贴纸占位模式可直接跑）
assets/vendor/           PixiJS + Live2D 渲染（见 NOTICE-Live2D.md）
```

## 技术说明

- **主题开场**：主界面选的话题作为一条隐藏用户消息写进上下文，她以自己的口吻围绕话题先开口
- **档案记忆**：add/update/remove JSON 协议 + 宽容解析，存 `profile.json`（上限 60 条）；任何提取失败静默跳过，不影响主流程
- **情绪协议**：`[emotion:xxx]` 全角/半角冒号都认；漏输出不报错，只是该条不切表情
- **说话流程**：流式文本按句切分（句末标点 / 80 字上限），逐句送合成，PCM 按序无缝连播；新消息打断当前播报
- **窗口层级**：koffi 调 Win32 `SetWindowPos` 实现沉底——她住在桌面上，而不是浮在一切之上

## Live2D 说明

`assets/vendor/` 含 PixiJS（MIT）、pixi-live2d-display（MIT）与 Live2D Cubism Core
（Live2D 专有许可，**不受本仓库 MIT 覆盖**，见 [NOTICE-Live2D.md](NOTICE-Live2D.md)）。
只用视频皮肤可整个删除该目录。

## License 与边界

- 框架代码：[MIT](LICENSE)
- 你放入的角色素材、模型、参考音频：**不随本仓库分发**，版权归原权利人；克隆声音请确保你有权使用
- 本项目定位个人非商用；接入的模型服务请遵守各平台条款

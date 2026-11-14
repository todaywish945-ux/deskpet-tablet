# 给百度搭子的全流程指令模板

> 配套本仓库（平板桌宠框架 deskpet-tablet）使用。
> 玩家不需要写代码：把下面的指令卡逐张复制给百度搭子（DuMate 桌面端），它替你操作电脑完成搭建。
> **只想一次到位？** 用 [AUTOSETUP.md](AUTOSETUP.md) 的总控指令（填 5 个空整段发送，断点续跑）；本文件的分步卡适合精确控制和排障。
>
> **提示词对照本仓库源码逐条核对过**（配置字段、脚本行为、素材位置）。若你改过代码，请同步核对本文件引用的路径。

## 使用说明

1. 假设框架解压/克隆在 `D:\我的桌宠`，下面所有 `<尖括号>` 处替换成你自己的值。
2. **按 卡0 → 卡1 → 卡2 → 卡3 → 卡4 的顺序执行**，卡5/卡6 可选。顺序不敏感（音色注册已是合并写入），但按序最省心。
3. 每张卡都写了「成功标准」——搭子完成后，让它对照标准汇报证据（命令输出/文件内容/截图），你只负责确认。
4. 出问题用卡7 的排障模板，把现象描述清楚即可。

---

## 卡0 · 环境体检与依赖安装

**📋 给搭子的指令（复制）**

```text
我要在一台 Windows 电脑上运行一个 Electron 桌宠项目，项目在 D:\我的桌宠。
请你完成环境体检并修复缺失项：

1. 运行 node -v，如果低于 18 或没有 Node.js，去 https://nodejs.org 下载 LTS 版
   Windows 安装包（.msi）静默安装，装完重新开一个终端验证 node -v。
2. 进入 D:\我的桌宠 执行 npm install，成功标准：命令退出码为 0，没有 ERR! 行。
   如果失败，删除 node_modules 和 package-lock.json 后重试一次。
3. 执行 npm run typecheck，报告是否零错误（这一步只是体检，不启动应用）。

每一步完成后把关键输出贴给我；全部通过后说「环境就绪」。
任何一步连续失败两次就停下来向我汇报，不要自行改项目源码。
```

**✅ 成功标准**：`node -v` ≥ 18；`npm install` 无 ERR；`npm run typecheck` 无 error。

**⚠️ 失败时补一句**：「可能是网络问题，给 npm 换成国内镜像（npm config set registry https://registry.npmmirror.com）后再装一次。」

---

## 卡1 · 注册克隆音色（阿里云百炼，一次性）

**📋 给搭子的指令（复制）**

```text
项目在 D:\我的桌宠。帮我完成语音克隆音色注册（用我自己的参考音频）：

1. 我把参考音频放在了 <参考音频的完整路径>（要求：单人说话、无明显背景噪音、
   建议 10 秒以上）。请把它复制并覆盖为 D:\我的桌宠\assets\voice\reference.mp3
   （保持这个文件名）。
2. 在用户环境变量里设置 DASHSCOPE_API_KEY，值为 <我的百炼 API Key>
   （在阿里云百炼平台申请）。设置命令：setx DASHSCOPE_API_KEY "<Key>"。
3. 在 D:\我的桌宠 下执行 node scripts/enroll-and-test.mjs。
   脚本会自己检查参考音频是否存在、是否太小，缺了会明确报错。
4. 成功后它会在 D:\我的桌宠\scripts\ 生成 试听.wav，把这个文件的完整路径告诉我，
   我要自己点开听一下效果。

成功标准：脚本最后输出「已写入配置（合并模式）」和「试听文件」，没有 FAIL 字样。
注意：脚本只更新语音相关的配置字段（合并写入，不会动其他设置）；
注册成功后不要重复运行此脚本（会重复创建音色）。
```

**✅ 成功标准**：输出「音色注册成功 voice_id = …」「已写入配置（合并模式）」「试听文件」；你亲耳听过 `试听.wav`。

**⚠️ 失败时补一句**：
- 提示「未找到 DASHSCOPE_API_KEY」→「用 PowerShell 执行 [Environment]::GetEnvironmentVariable('DASHSCOPE_API_KEY','User') 确认变量确实写进去了，没有就重新 setx 一次再跑。」
- 提示找不到参考音频 → 「确认第 1 步复制的目标路径和文件名完全正确，再跑一次。」
- 上传或注册 FAIL → 「把脚本完整输出原样贴给我，不要自己改脚本。」

---

## 卡2 · 填智谱 API Key（对话 + 语音输入共用）

> 推荐环境变量方式：写在环境变量里不怕被任何脚本或重装影响；框架检测到配置里没有 Key 时会自动读它。

**📋 给搭子的指令（复制，二选一）**

方式 A（推荐，环境变量）：

```text
在用户环境变量里设置 ZHIPU_API_KEY，值为 <我的智谱 API Key>（bigmodel.cn 申请）：
setx ZHIPU_API_KEY "<Key>"
设置完读回变量值确认（Key 中间打码显示给我）。
```

方式 B（写进配置文件）：

```text
打开 C:\Users\<你>\AppData\Roaming\deskpet-tablet\data\config.json，
只把 llm.apiKey 字段改成 <我的智谱 API Key>，其他任何字段都不许动。
改完把文件读一遍给我确认（Key 打码）。
```

**✅ 成功标准**：变量读回有值，或 config.json 中 `llm.apiKey` 非空。

**⚠️ 失败时补一句**：「如果 config.json 不存在，说明应用还没启动过。先执行一次卡4 的启动指令让它生成默认配置，再回来改。」

---

## 卡3 · 装角色皮肤（人设 + 动画 + 表情贴纸）

> 框架用「皮肤包」组织一切角色素材。仓库内置的 `assets/skins/yeshunguang`（叶瞬光，非官方同人）开箱即用——只想用她就跳过本卡，设置里选她即可。想做自己的角色：仓库自带 `assets/skins/template` 空骨架，没有动画素材时自动进入贴纸占位模式，流程照常可跑。

**第 1 步 · 建立你的皮肤**：

```text
项目在 D:\我的桌宠。把模板皮肤 assets\skins\template 整个文件夹复制一份为
assets\skins\<我的皮肤id>（id 用小写英文，和文件夹同名）。
打开新皮肤的 skin.json，把 id 改成 <我的皮肤id>、name 改成 <我的角色名>，
其他字段先不动，把改后的 skin.json 内容展示给我确认。
素材规格细节见 D:\我的桌宠\ASSET-GUIDE.md，改之前先读一遍。
```

**第 2 步 · 填入素材**：

```text
我把素材放在了 <素材文件夹路径>。请按 ASSET-GUIDE.md 的对应关系复制进
assets\skins\<我的皮肤id>\：
  prompts\character.md   ← 我的人设（必须保留末尾情绪协议段）
  avatar.png             ← 头像
  animations\*.mp4 + manifest.json   ← 动作切片与清单（没有动画素材就跳过，占位模式能跑）
  stickers\*.png + reactions.json    ← 表情贴纸
完成后逐项验证并汇报：a) skin.json 里 persona 指向的文件存在；
b) manifest.json（如果有）引用的每个视频文件都存在；c) 设置窗口皮肤下拉里能看到我的角色名。
```

**✅ 成功标准**：`skin.json` 的 `id`/`name` 已改；`persona`、`manifest`、`reactions` 指向的文件都真实存在。

**⚠️ 失败时补一句**：「动画素材我还没有，先用占位模式跑通流程，人设（character.md）先替换，之后再换动画。」

**换装 Live2D 模型**：皮肤 `backend` 改 `"live2d"`，`model` 指向 `model/xxx.model3.json`，`emotions` 表里每个情绪对应模型里的**表情名**（见 ASSET-GUIDE.md §Live2D）。

---

## 卡4 · 启动与验收

**📋 给搭子的指令（复制）**

```text
在 D:\我的桌宠 执行 npm run dev 启动桌宠（开发模式）。
启动后帮我确认这四件事，逐项报告：
1. 桌面上出现了平板形态的窗口（有边框可拖动）；
2. 系统托盘出现了应用图标；
3. 在平板里发一条「你好」等她回复，确认打字机能出字；
4. 右键平板边框 → 设置 能打开设置窗口，皮肤下拉里能看到我的皮肤。
如果启动失败或窗口没出现，读 %APPDATA%\deskpet-tablet\logs\ 下最新的
日志文件，定位原因后最小化修复并重启验证。
```

**✅ 成功标准**：四项全部通过；她说话时有声音（没声音回卡1检查）。

**⚠️ 失败时补一句**：「如果报端口占用或 Electron 残留进程，先结束所有 node/electron 进程再启动；还失败就把日志贴给我。」

---

## 卡5 · 打包成安装包（可选）

**📋 给搭子的指令（复制）**

```text
在 D:\我的桌宠 执行 npm run dist 打包 Windows 安装包。
成功标准：dist_app\ 目录下生成 .exe 安装包。
打完后告诉我安装包的完整路径和大小。注意打包过程约几分钟，不要中途打断。
```

**⚠️ 失败时补一句**：「koffi 是原生模块，必须保持 package.json 里 asarUnpack 包含 koffi，检查后再重试。」

---

## 卡6 · 本地语音：GPT-SoVITS（可选，零 API 费用，需 NVIDIA 显卡）

> 在线克隆走卡1 就够了。这条路线免费、离线、音色更稳，但要自己训练/配置模型。

**📋 给搭子的指令（复制）**

```text
我想把语音从百炼在线合成切换到本地 GPT-SoVITS。GPT-SoVITS 整合包已解压在
<GPT-SoVITS整合包目录>（必须是纯英文路径）。请修改
C:\Users\<你>\AppData\Roaming\deskpet-tablet\data\config.json 的 tts 段：
  "enabled": true,
  "provider": "gptsovits",
  "gsvApiBase": "http://127.0.0.1:9880",
  "gsvRefAudio": "<参考音频绝对路径，3~10 秒清晰人声>",
  "gsvRefText": "<参考音频的逐字文本>",
  "gsvPromptLang": "zh",
  "gsvTextLang": "zh",
  "gsvLauncherPath": "<整合包目录里的启动脚本路径，必填>"
其他字段不动。改完读回 tts 段给我确认。
```

**✅ 成功标准**：config.json 的 tts 段如上；桌宠说话有声音。

**⚠️ 失败时补一句**：
- 没声音 → 「先手动用整合包的 runtime\python.exe api_v2.py 起服务，看到 Uvicorn running 后再让她说话；应用检测到服务在线就不会重复拉起。」
- 仍然没声音 → 「读 %APPDATA%\deskpet-tablet\logs\gsv-autostart.log 贴给我。检查整合包路径里不能有中文。」

> 模型训练本身在整合包自带的 WebUI 里做（数据集处理→微调），框架只负责调用 api_v2。

---

## 卡7 · 通用排障模板（万能卡）

**📋 给搭子的指令（复制）**

```text
桌宠出问题了。现象：<一句话描述，例如"她不说话了"/"语音输入没反应"/"启动后窗口一闪就没了">。

请你按这个流程处理：
1. 读 %APPDATA%\deskpet-tablet\logs\ 下最新的日志文件最近 50 行；
2. 从日志定位直接原因，向我复述你的判断；
3. 提出最小化修复方案，等我回复"可以"后再动手；
4. 修复后按卡4 的四项标准重新验收并汇报。
不许重装系统级软件，不许改动 assets 和 src 之外的代码。
```

**常见现象 → 先查什么**（贴给搭子能加快定位）：
- 没声音 → config.json 的 `tts.voice` 是否为空（回卡1）；`tts.provider` 与实际引擎是否一致
- 打字没回复 → `llm.apiKey` 是否为空（卡2）
- 语音输入没反应 → 智谱 Key（ASR 与对话共用同一个 Key）
- 窗口不见了 → 托盘图标右键退出重开；日志里找窗口创建报错

---

## 卡8 · 一键总指令（懒人版）

```text
项目在 D:\我的桌宠，请按顺序执行以下任务，每完成一步停下来向我汇报证据后再继续，
任何一步失败就停：

第1步 环境就绪：node ≥ 18、npm install 成功、npm run typecheck 通过。
第2步 音色注册：我的参考音频在 <路径>，百炼 Key 是 <Key>。
      把它覆盖为 assets\voice\reference.mp3，setx DASHSCOPE_API_KEY 后
      运行 node scripts/enroll-and-test.mjs，最后告诉我试听.wav 在哪。
第3步 填智谱 Key：setx ZHIPU_API_KEY "<Key>"。
第4步 皮肤确认：内置叶瞬光皮肤在 assets\skins\yeshunguang（开箱即用），确认其
      skin.json 存在并把 config.json 的 character.skin 设为 yeshunguang
      （我给了自己的素材则按 ASSET-GUIDE 放进 template 并切到 template）。
第5步 启动验收：npm run dev，确认平板窗口出现、打字有回复、说话有声音。

完成后给我一份清单：每步的结果 + 当前 config.json 的 tts/llm/character 三段内容（Key 打码）。
```

---

## 附录A · skin.json 字段速查

| 字段 | 说明 |
|---|---|
| `id` | 皮肤标识 = 文件夹名 |
| `name` | 设置下拉里显示的名字 |
| `backend` | `"video"`（视频切片）/ `"live2d"`（实时模型） |
| `manifest` / `loopPoints` | 视频后端：动作清单 / 无缝循环点 |
| `reactions` | 情绪→贴纸映射（也是占位模式兜底） |
| `model` | Live2D 后端：model3.json 入口 |
| `emotions` | Live2D：情绪→表情名；视频后端留 `{}` |
| `avatar` / `wallpaper` / `tray` | 头像 / 壁纸 / 托盘图（后两个可选） |
| `persona` | **人设（系统提示词全文）** |

- 内置皮肤在 `assets\skins\`；**用户自装皮肤放 `%APPDATA%\deskpet-tablet\skins\<id>\`，优先级更高**。
- 没有 `manifest` 文件时自动进入贴纸占位模式，流程照常。

## 附录B · 人设写作要点

人设文件 = 对话时的**系统提示词全文**。模板在 `assets\skins\template\prompts\character.md`：

1. **身份直给**：「你就是她」，第一人称设定，不写"你要扮演"。
2. **说话风格具体化**：口头禅、句长习惯 + 三句不同场景的例句——比形容词有效得多。
3. **结尾情绪标签协议（必须保留）**：每条回复末行 `[emotion:情绪名]`，24 个合法情绪见模板。

## 附录C · 参考音频要求

- **百炼克隆（卡1）**：单人说话、无背景音乐/噪音、无混响，建议 10 秒以上，覆盖为 `assets\voice\reference.mp3`。
- **GPT-SoVITS（卡6）**：`gsvRefAudio` 3~10 秒清晰人声，`gsvRefText` 必须**逐字**与音频一致。
- 只克隆自己有权使用的声音（自己的声音，或获授权的声音）。

## 附录D · 有效性与版本

- 本文件所有路径、字段名、脚本行为均对照本仓库源码核对：
  配置结构 `src/shared/types.ts`（DEFAULT_CONFIG）、配置读写 `src/main/services/store.ts`、
  人设加载 `src/main/services/llm.ts` + `chatPipeline.ts`、音色注册 `scripts/enroll-and-test.mjs`（合并写入）、
  本地语音 `src/main/services/gsv.ts`、皮肤列表 `src/main/ipc.ts`。
- `enroll-and-test.mjs` 为**合并写入**（只更新 tts 相关字段，保留其他配置），卡与卡之间的顺序不再敏感；
  按序执行依然是推荐做法。

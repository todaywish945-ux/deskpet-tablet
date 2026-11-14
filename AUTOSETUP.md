# 全自动配置工作流（发给百度搭子，一次到位）

> 设计目标：**观众几乎不用动电脑**。从视频简介/置顶评论复制一段指令发给百度搭子（DuMate 桌面端），
> 它自己下载框架、装环境、配密钥、注册音色、放素材、启动并自检；断了发「继续」接着干。
> 分步控制与排障用 [PROMPTS-FOR-DUMATE.md](PROMPTS-FOR-DUMATE.md)。

## 使用方法（观众版，3 步）

1. 电脑装好**百度搭子**（dumate.baidu.com，普通软件安装）
2. **复制置顶评论里的总控指令**（UP 主已预填好下载地址），粘贴发给搭子
3. 等它跑完，最后它停下来让你亲眼确认一次

观众全程真正要动手的只有三件事：**装搭子、注册拿 Key、粘贴一次**。
Key 只在要声音时才需要第二把；什么都不填也能先文字聊天。

## 【我的信息】（只有第 1 项必填，发给搭子前填好）

```text
智谱 API Key：<必填，对话要用。获取：bigmodel.cn 注册 → 控制台 → API Keys，复制>
框架下载地址：<可选；置顶评论里的版本已填好。自己从本文件复制时：填 GitHub Release 直链
              或网盘链接；写「无」= 搭子自己在电脑上找已解压的框架>
语音引擎：bailian（在线克隆，默认）/ gptsovits（本地免费，需已装好 GPT-SoVITS 整合包）
百炼 API Key：<仅 bailian 且想要声音时填；bailian.console.aliyun.com 按页面提示开通后创建 API-KEY>
参考音频：<完整路径，单人清晰人声；bailian 建议 ≥10 秒 / gptsovits 需 3~10 秒；没有写「无」= 暂时文字聊天>
GPT-SoVITS 整合包目录：<仅 gptsovits 时填；纯英文路径，整合包需自己提前下载解压>
人设文件：<可选，.md 文本路径；没有写「无」= 用内置通用人设「阿板」，开箱就能聊>
素材文件夹：<可选，你自己的头像/动画/贴纸文件夹；没有写「无」= 用内置叶瞬光皮肤（开箱即完整形态，人设与语音参考都自带）>
```

> **分享给别人时**：把【框架下载地址】预填为固定直链
> `https://github.com/todaywish945-ux/deskpet-tablet/archive/refs/heads/main.zip`
> 再把整段总控指令发给对方（或贴在分享帖/群里）——对方复制即用，连填空都不用碰。

---

## 安装包版总指令（推荐，复制整段发给搭子）

> 最省事的路线：AI 下载安装包 → 装好 → 写入你的 Key → 带你开通声音。不需要 Node、不需要源码。
> 源码版总指令（想魔改或源码运行）在下方。

```text
你是我的电脑配置助手。目标：安装并配置「平板桌宠」——一块摆在桌面上的平板，AI 角色「住」在里面，会聊天、有情绪表情、用克隆的声音说话。
严格按阶段执行：每阶段完成 → 对照验收标准自检 → 更新进度文件 → 一句话向我简报 → 进入下一阶段。

【我的信息】
智谱 API Key：<必填，对话要用；bigmodel.cn 注册获取>
配音方式：<可留空——AI 会检测你的电脑条件后给你选项；也可直接写
A 在线克隆 / B 本地 GPT-SoVITS（下一行给整合包目录）/ C 暂不配声音>
整合包目录：<仅 B 需要；GPT-SoVITS 整合包解压后的目录，纯英文路径>

【进度管理（最先做）】
进度文件 %APPDATA%\deskpet-tablet\配置进度.json，格式 {"stage":"","status":"done|failed","evidence":""}。
已存在则跳过 status=done 的阶段从断点继续，绝不重做。每完成/失败一个阶段立即更新它。

【阶段 1 · 下载并安装】
1. 下载安装包（约 312MB）到下载文件夹：
   主链接 https://github.com/todaywish945-ux/deskpet-tablet/releases/download/v1.1/deskpet-tablet-setup-0.1.0.exe
   下载失败或太慢就换镜像：在完整链接前面加 https://gh-proxy.com/ 前缀再下。
2. 静默安装：运行安装包并加参数 /S；或启动向导让我点完。
3. 从桌面/开始菜单的「平板桌宠」快捷方式启动。
验收：安装目录存在主程序 exe，进程在运行。
连续失败 2 次（含换镜像重试）→ 停下把输出贴给我。

【阶段 2 · 写入 API Key（需要先退出应用）】
1. 退出平板桌宠（托盘图标右键 → 退出桌宠；或结束对应进程）。
2. 打开/创建 %APPDATA%\deskpet-tablet\data\config.json：
   - 我的智谱 Key 填进 llm.apiKey
   - 我的百炼 Key（如果给了）填进 tts.apiKey
   其他任何字段不许动。注意：应用首次运行**不会**生成 config.json（只在保存设置时写入）——
   文件不存在就直接创建 data 目录和 config.json 并写入完整 JSON。
3. 重新启动平板桌宠。
验收：访问 http://127.0.0.1:37820/health 返回 JSON 且 "app":"deskpet-tablet"。

【阶段 3 · 配音方式：先检测条件，再让我选择】
三种方式：A 在线克隆（百炼，按量计费，无需显卡）/ B 本地 GPT-SoVITS（完全免费，需英伟达 N 卡）
/ C 暂不配声音（纯文字聊天）。
1. 先自己静默检测，不打扰我：
   a. 有无 N 卡：运行 nvidia-smi --query-gpu=name --format=csv,noheader ——有输出=✓，报错=✗；
   b. 本地引擎：我在【我的信息】给了整合包目录则检查「目录存在且路径为纯英文」；没给=✗；
   c. 在线克隆：我在【我的信息】给了百炼 Key=✓，没给=✗。
2. 把检测结果连同三种方式的条件一起告诉我（每条标 ✓/✗），让我选 A/B/C。
   若我在【我的信息】里已明确选了方式，直接采用，不再重复问。
3. 按我的选择执行：
   ▶ A 在线克隆：
     - 百炼 Key ✓：打开设置窗口（右键平板边框 → 设置），带我依次点
       「① 用参考音频注册克隆音色」「② 试听」——参考音频已内置，不用找；
     - 我想用 A 但没有百炼 Key：带我开通——浏览器打开 bailian.console.aliyun.com，
       引导我开通服务并创建 API Key，我贴给你后写入 tts.apiKey，再走上一条。
   ▶ B 本地 GPT-SoVITS：
     - N卡 ✓ + 整合包 ✓：退出平板桌宠 → 修改 %APPDATA%\deskpet-tablet\data\config.json
       的 tts 段：
       "provider": "gptsovits",
       "gsvApiBase": "http://127.0.0.1:9880",
       "gsvRefAudio": "<安装目录>\resources\assets\voice\gsv-ref.wav",
       "gsvRefText": "亦余心，道心唯居，剑法自然。",
       "gsvPromptLang": "zh", "gsvTextLang": "zh",
       "gsvLauncherPath": "<整合包目录里的启动脚本路径>"
       参考音频已内置在安装目录，不用另找；其他字段不动 → 重启平板桌宠；
     - N卡 ✓ 但整合包 ✗：告诉我"需要下载 GPT-SoVITS 整合包（约 10GB，N卡专用）"——
       下载途径：https://github.com/RVC-Boss/GPT-SoVITS/releases 页找 Windows 整合包（.7z），
       国内下载慢就在链接前加 https://gh-proxy.com/ 前缀；解压到纯英文路径（如 D:\GPT-SoVITS），
       然后把目录告诉我，我下好说一声"下好了"你再继续，期间不要自行下载 10GB 大文件；
     - 无 N卡 ✗：明确告诉我"你的电脑没有英伟达显卡，本地引擎用不了"，建议 A 或 C。
   ▶ C：跳过语音配置，说明纯文字聊天已可用、以后随时能补。
验收：A → 注册成功提示出现，或我确认听到了试听；
      B → 她说第一句话时框架会自动拉起本地服务（首次等 1~2 分钟属正常），有声即过，
          失败读 %APPDATA%\deskpet-tablet\logs\gsv-autostart.log 最后 30 行贴给我；
      C → 本阶段直接通过。

【阶段 4 · 最终验收与报告】
1. 让我人眼确认三件事：桌面出现平板、发一条消息她有回复、（配了声音）她开口有声音。
2. 给我最终报告：每阶段结果 + config.json 的 llm/tts 两段内容（Key 打码）。

【全局规则】
- 不许修改安装目录内文件与任何源码；不许重复运行安装包；Key 在一切汇报里打码。
- 我提供的 Key 只写入本机配置文件，不得发送给任何第三方。
- 任何阶段连续失败 2 次：停下，贴最后的输出，等我决定。
- 下载的安装包如果凭空消失或双击没反应：去杀毒软件（火绒/360/Defender）的
  隔离区恢复文件，或把安装包加入信任区后重试——未签名 exe 被静默查杀很常见。
- 你执行任何带中文内容的 HTTP 请求（如测试对话）时，把 JSON 写成 UTF-8 文件再
  用 --data-binary @文件 发送——Windows 控制台内联中文会变成 GBK 乱码。
```

---

## 总控指令·源码版（复制下面整段发给搭子）

```text
你是我的电脑配置助手。目标：把「平板桌宠框架」从零配置到能正常对话。
严格按阶段顺序执行：每阶段完成 → 对照验收标准自检 → 更新进度文件 → 一两句话向我简报 → 自动进入下一阶段。

【阶段 0 · 拿到框架 + 进度管理】
1. 确定"框架目录"：
   - 【框架下载地址】≠ 无 且 D:\deskpet 下没有 package.json：把该地址的压缩包下载到
     下载文件夹（浏览器下载或 curl 都行），解压到 D:\deskpet；
   - 下载地址 = 无：依次在 桌面、下载文件夹、D:\ 盘根 找已解压的框架文件夹
     （标志：里面有 package.json 和 src 文件夹）；找不到就停下问我框架放在哪了。
2. 进度文件 = <框架目录>\配置进度.json，格式 {"stage":"","status":"done|failed","evidence":""}。
   若已存在，跳过 status=done 的阶段从断点继续，绝不重做。每完成/失败一个阶段立即更新它。
验收：框架目录下同时存在 package.json、src、assets。

【阶段 1 · 环境】
1. node -v 必须 ≥18，没有就去 nodejs.org 下 LTS 版 .msi 静默安装，装完重开终端验证。
2. 在框架目录执行 npm install；失败就删掉 node_modules 和 package-lock.json，
   设置国内镜像（npm config set registry https://registry.npmmirror.com）后重试。
3. 执行 npm run typecheck，应当零 error。
验收：三步全过。连续失败 2 次 → 停下，把报错原文给我。

【阶段 2 · 密钥与语音】
1. 执行 setx ZHIPU_API_KEY "<智谱Key>"（若我填的是「无」，按文末"引导我拿 Key"规则处理）。
2. 语音引擎按【我的信息】里填的执行（二选一）：
   ▶ bailian（在线克隆，参考音频 ≠ 无 时）：
     a. 把我的参考音频复制覆盖为 <框架目录>\assets\voice\reference.mp3；
     b. setx DASHSCOPE_API_KEY "<百炼Key>"（Key=无 时同样走"引导我拿 Key"）；
     c. 读 %APPDATA%\deskpet-tablet\data\config.json，如果 tts.voice 已经非空，
        跳过注册（防止重复创建音色），只报告现有音色；
     d. 否则在框架目录执行 node scripts/enroll-and-test.mjs。
        脚本会自己检查音频，结尾输出「已写入配置（合并模式）」并生成 scripts\试听.wav，
        把 试听.wav 完整路径告诉我。
   ▶ bailian 且参考音频 = 无：跳过语音，记录「暂无语音，文字聊天可用」。
   ▶ gptsovits（本地免费）：
     a. 确认整合包目录存在且路径为纯英文，不是就停下问我；
     b. 把 %APPDATA%\deskpet-tablet\data\config.json 的 tts 段改为：
        "enabled": true, "provider": "gptsovits",
        "gsvApiBase": "http://127.0.0.1:9880",
        "gsvRefAudio": "<参考音频绝对路径>",
        "gsvRefText": "<参考音频的逐字文本>",
        "gsvPromptLang": "zh", "gsvTextLang": "zh",
        "gsvLauncherPath": "<整合包目录里的启动脚本路径>"
        其他字段一个不动，改完读回给我确认；
     c. 框架会在她说第一句话时自动拉起本地服务，首次加载模型 1~2 分钟属正常。
验收：ZHIPU_API_KEY 用户环境变量读回有值；
      bailian →（做了注册）脚本无 FAIL；gptsovits → config.json 的 tts 段与上面一致。
注意：注册脚本只更新语音相关配置字段，是合并写入，不许"修复"它。

【阶段 3 · 素材落位（大多数情况跳过）】
框架已内置完整皮肤 assets\skins\yeshunguang（叶瞬光，默认启用）及其人设、语音参考。
素材文件夹 = 无：什么都不用做，跳过本阶段。
素材文件夹 ≠ 无（我自己的角色素材）：
1. 把我的人设 .md 复制覆盖 assets\skins\template\prompts\character.md
   （先读一下确认它末尾保留 [emotion:xxx] 情绪协议段，被删了就在我原文件后面补上这一节）；
2. 按 <框架目录>\ASSET-GUIDE.md 把头像/动画/贴纸放进 assets\skins\template\；
3. 读 %APPDATA%\deskpet-tablet\data\config.json，把 character.skin 改为 "template"。
验收：persona 指向的文件存在；（若放了 manifest）引用文件全部存在；config 已指向对应皮肤。

【阶段 4 · 启动与冒烟】
1. 在框架目录用**新窗口**启动 npm run dev（别阻塞你的终端），等 30 秒。
2. 程序化冒烟：访问 http://127.0.0.1:37820/health，返回 JSON 即应用活着；
   不通就等 10 秒重试 3 次；仍不通读 %APPDATA%\deskpet-tablet\logs\ 最新日志定位，
   最小化修复后重启再测。
3. 冒烟通过后【停下问我】：让我人眼确认桌面上出现平板窗口、打字有回复。
验收：/health 返回 JSON + 我确认看到了界面。

【阶段 5 · 交付报告（对话确认通过后再做）】
给我一份最终清单：
- 每阶段结果与一句话证据；
- %APPDATA%\deskpet-tablet\data\config.json 的 llm/tts/character 三段内容（**Key 打码**）；
- 试听.wav 路径（如果注册过）；
- 接下来我要自己做的事：点开听试听效果 / 以后换素材就改 template 目录 / 想打包就执行 npm run dist。

【引导我拿 Key（仅在 Key=无 且该 Key 影响对应功能时启用）】
先别直接跳过：用浏览器打开对应注册页（智谱 bigmodel.cn；百炼 bailian.console.aliyun.com），
把页面摆到我面前，口头带我走到"创建/复制 API Key"那一步；我把 Key 贴给你之后，
你替我执行 setx 写入用户环境变量，然后继续流程。只有我明确说"先不弄"才真正跳过并在报告里记录。

【全局规则】
- 不许修改 src\ 目录任何代码；不许执行 npm run dist；不许重复注册音色。
- 任何汇报里 API Key 一律中间打码。
- 任何阶段连续失败 2 次：停下，贴日志最后 30 行，等我决定。
- 需要联网下载的走官方源，npm 失败才用上面的国内镜像。
```

---

## 为什么这样设计

- **下载解压也不归观众管**：总指令第一阶段就让搭子自己下载、解压、找目录——观众不碰路径
- **填空最少化**：必填只剩智谱 Key 一项；声音、形象全部可后补，"无"是合法答案
- **带我拿 Key**：注册没法替观众做（要手机号），但搭子可以把注册页面直接开到观众面前带到复制那一步——把"不会用电脑"的成本压到跟一次普通网页注册一样
- **进度文件**：`配置进度.json` 让任何中断都能「继续」续跑，不会重装重复注册
- **验收门禁**：每阶段硬标准，连败 2 次强制停——防止搭子为"完成"瞎修
- **默认皮肤即目标**：素材放进 `template` 目录零配置生效；想多皮肤再看 [PROMPTS-FOR-DUMATE.md](PROMPTS-FOR-DUMATE.md) 卡3
- **程序化冒烟**：`/health` 接口让它不靠截图判断应用死活

## 已知边界

- **GPT-SoVITS 整合包的下载与模型训练**不做进自动工作流（10GB 大文件 + 版本选择，易碎）：已装好整合包的玩家直接在【我的信息】里选 gptsovits 全自动切换；没装的先用 bailian，想换看下面附录。训练（可选，让音色更稳更像）在整合包自带 WebUI 里做
- **无参考音频**时纯文字聊天正常，她说话会有"未配置语音"的友好提示，不算故障
- **框架下载直链**依赖 UP 主发布 Release 后把真实地址填进置顶评论；直链失效时观众会卡在阶段 0（搭子会停下来问）
- 这份提示词**无法在作者机器上代跑百度搭子验证**——UP 主是第一个用户：跑完后哪个阶段卡住，把那一阶段的对话记录发回来改提示词

---

## 附录 · 语音引擎怎么选（二选一）

| | 百炼在线克隆（bailian） | GPT-SoVITS 本地（gptsovits） |
|---|---|---|
| 费用 | 按量计费（一直花小钱，欠费即哑） | **完全免费**，无限量 |
| 门槛 | 注册百炼 + 一段参考音频（≥10 秒） | **N卡**（英伟达显卡，建议 6GB+ 显存）+ 10GB 整合包 |
| 配置难度 | ★ 全自动可配 | ★★★ 需自备整合包、填路径 |
| 音色 | 像参考音频，开箱稳定 | 零样本即可用（3~10 秒参考音频）；自己训练后更稳更像 |
| 速度 | 网络往返，首句稍慢 | 本地合成，热请求快 |
| 断网 | 没声音 | 照常说话 |
| 资源占用 | 无 | 服务常驻显存约 3GB（开着游戏抢显存时合成会变慢） |

**怎么选**：想省事、没有 N卡 → bailian；重度使用、想零成本、有 N卡 → gptsovits。
先用 bailian 跑通、之后切本地也完全可以。

**已装好整合包、想从百炼切到本地**：把这段发给搭子——

```text
帮我把桌宠语音从百炼切到本地 GPT-SoVITS。整合包在 <整合包目录>（纯英文路径）。
改 %APPDATA%\deskpet-tablet\data\config.json 的 tts 段：
  "enabled": true, "provider": "gptsovits",
  "gsvApiBase": "http://127.0.0.1:9880",
  "gsvRefAudio": "<3~10 秒参考音频绝对路径>",
  "gsvRefText": "<参考音频逐字文本>",
  "gsvPromptLang": "zh", "gsvTextLang": "zh",
  "gsvLauncherPath": "<整合包目录里的启动脚本路径>"
其他字段不动，改完读回确认。然后重启桌宠（结束 node/electron 进程后在框架目录
npm run dev），她说第一句话时会自动拉起本地服务，首次等 1~2 分钟。
验收：读回的 tts 段一致 + 她说话有声。失败就读
%APPDATA%\deskpet-tablet\logs\gsv-autostart.log 最后 30 行贴给我。
```

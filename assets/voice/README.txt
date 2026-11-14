本目录已内置一份参考音频（reference.mp3，来自内置叶瞬光皮肤，版权归米哈游，仅供个人非商用学习）。

想直接用内置声音：在用户环境变量设置 DASHSCOPE_API_KEY（阿里云百炼平台的 Key），执行：

    node scripts/enroll-and-test.mjs

注册成功会生成 scripts/试听.wav 供你确认效果。

想换成你自己的声音：把你的参考音频（单人清晰人声、无背景噪音，建议 10 秒以上）覆盖为
本目录的 reference.mp3，再执行上面的注册命令。
只克隆你有权使用的声音（自己的声音，或已获授权的声音）。
gsv-ref.wav 供本地 GPT-SoVITS 路线使用（参考文本见设置页说明）。

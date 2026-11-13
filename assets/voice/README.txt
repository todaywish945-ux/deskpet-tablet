把你的参考音频放到本目录，命名为 reference.mp3（单人清晰人声，无背景噪音，建议 10 秒以上），
然后在用户环境变量设置 DASHSCOPE_API_KEY（阿里云百炼平台的 Key），执行：

    node scripts/enroll-and-test.mjs

注册成功会生成 scripts/试听.wav 供你确认效果。
只克隆你有权使用的声音（自己的声音，或已获授权的声音）。

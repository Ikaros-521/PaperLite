# 英文词表来源

`en.txt` 取自 npm 包 [an-array-of-english-words](https://www.npmjs.com/package/an-array-of-english-words)（MIT 许可），
词表本身源自 [SCOWL](http://wordlist.aspell.net/)（Spell Checker Oriented Word Lists）。

- 约 27.5 万词，一行一词，小写
- 应用懒加载（首次编辑英文文档时才拉取），HTTP 缓存复用
- 运行时另做常见屈折还原（复数 / 过去式 / 现在分词 / 所有格），词典外的新词
  可存入 localStorage `paperlite.spell-user-words`（数组）作为用户词表

// 梗百科查询 worker：stdin 收 JSON {message}，stdout 回 JSON {found, title?, entry?}。
// 数据源是 dsh-memewiki 插件的 memes.db（SQLite）。必须用系统 Node ≥22.13 跑
// （node:sqlite），Electron 内置的 Node 20 没有——由主进程 spawn，别 require 进包。
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const req = JSON.parse(readFileSync(0, 'utf8'))
const out = (obj) => process.stdout.write(JSON.stringify(obj))

try {
  const db = new DatabaseSync(req.db, { readOnly: true })
  const msg = String(req.message ?? '').trim()

  // ① 问梗句式里抠出查询词：「X是什么梗」「X啥意思」「X的出处」……
  let term = ''
  let asked = false // true=在求解释；false=在用梗/玩梗（顺势接，别解释定义）
  const m = msg.match(
    /^(.{1,24}?)(?:是什么梗|是啥梗|是个什么梗|是什么意思|是啥意思|啥意思|什么意思|是什么玩意|是什么出处|什么出处|的出处|哪里来的|哪来的)/
  )
  if (m) {
    asked = true
    term = m[1].replace(/^[「『"'（(【\s]+|[」』"'）)】\s]+$/g, '').trim()
  }
  // ② 没有句式但消息本身很短且无标点 → 当作裸词查询（「码头」，求解释）
  if (!term && msg.length <= 12 && !/[。！？!?，,~～]/.test(msg)) {
    asked = true
    term = msg
  }

  const pick = (row, isAsked) => ({
    found: true,
    asked: !!isAsked,
    title: row.title,
    entry: (row.summary || `${row.origin ?? ''}\n${row.usage ?? ''}`).trim().slice(0, 600),
    usage: (row.usage ?? '').trim().slice(0, 800),
    // 梗的「标准接法」：词条用法里写的「要回复 …」接龙句（有就带回）
    chain: ((row.usage ?? '').match(/要回复\s*([^\n]+)/) || [])[1] ?? ''
  })

  // ③ 精确命中（标题/slug/别名——拼音缩写类梗通常存在别名栏）→ 双向模糊 → 一条都不多
  if (term) {
    const exact = db
      .prepare('SELECT * FROM memes WHERE title = ? OR slug = ? OR aliases = ?')
      .get(term, term, term)
    if (exact) {
      out(pick(exact, asked))
      process.exit(0)
    }
    if (term.length >= 2) {
      const like = db
        .prepare(
          'SELECT * FROM memes WHERE (title LIKE ? OR aliases LIKE ?) AND length(title) >= ? ORDER BY length(title) LIMIT 1'
        )
        .get(`%${term}%`, `%${term}%`, term.length)
      if (like) {
        out(pick(like, asked))
        process.exit(0)
      }
    }
  }
  // ④ 反向命中：没有问句式、但消息里出现了已知梗名 = 用户在玩梗/用梗
  if (msg.length >= 4) {
    const rev = db
      .prepare('SELECT * FROM memes WHERE instr(?, title) > 0 ORDER BY length(title) DESC LIMIT 1')
      .get(msg)
    if (rev) {
      out(pick(rev, false))
      process.exit(0)
    }
  }
  out({ found: false })
} catch (e) {
  out({ found: false, error: String(e).slice(0, 160) })
}

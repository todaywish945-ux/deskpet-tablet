/**
 * 梗百科接入：词库来自 DSH 的 dsh-memewiki 插件（本地 SQLite，零网络）。
 * Electron 内置 Node 20 没有 node:sqlite，所以 spawn 系统 Node（≥22.13）跑
 * assets/memewiki/query.mjs 查词——每轮对话一次，~100ms，对话节奏里无感。
 * 没装 DSH/词库/系统 Node 时安静关闭，对话照常。
 */
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { assetRoot } from './store'

const MEMES_DB = join(homedir(), '.dsh', 'dsh-memewiki', 'data', 'memes.db')

/**
 * 接龙记忆：上一个命中的梗 + 它的标准接法（词条用法里「要回复 …」写的原句）。
 * 用户短时间内抛出接法词（如「真的假的」）时，把接法喂回去让她把暗号玩完。
 */
let lastMeme: { title: string; chain: string; entry: string; at: number } | null = null
const RITUAL_WINDOW_MS = 3 * 60_000

export interface MemeHit {
  found: boolean
  /** true=用户在求解释；false=在玩梗/用梗（顺着接，不解释定义） */
  asked?: boolean
  /** true=这是接龙回合：用户抛出了上一梗的标准接法 */
  ritual?: boolean
  /** 该梗的标准接法原句（如「真的假的 我去真开播了」） */
  chain?: string
  title?: string
  entry?: string
}


/** 判断消息是不是在抛上一梗的标准接法（包含接法首词 / 与接法短语互含） */
function matchesChain(message: string, chain: string): boolean {
  const first = chain.trim().split(/\s+/)[0]
  if (!first) return false
  if (message.includes(first)) return true
  return message.length <= 12 && (first.includes(message) || chain.includes(message))
}

export async function findMeme(message: string): Promise<MemeHit | null> {
  const script = join(assetRoot(), 'memewiki', 'query.mjs')
  if (!existsSync(MEMES_DB) || !existsSync(script)) return null
  return new Promise((resolve) => {
    let done = false
    const finish = (v: MemeHit | null) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    const child = spawn('node', [script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 已退出
      }
      finish(null)
    }, 4000)
    child.on('error', () => {
      clearTimeout(timer)
      finish(null) // 系统没有 node：功能安静关闭
    })
    let buf = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const hit = JSON.parse(buf.trim()) as MemeHit & { usage?: string; chain?: string }
        if (!hit.found) {
          // 没查到新梗：先看是不是在接上一梗的标准接法
          if (
            lastMeme &&
            Date.now() - lastMeme.at < RITUAL_WINDOW_MS &&
            lastMeme.chain &&
            matchesChain(message, lastMeme.chain)
          ) {
            lastMeme.at = Date.now() // 接龙继续：刷新窗口
            finish({
              found: true,
              asked: false,
              ritual: true,
              chain: lastMeme.chain,
              title: lastMeme.title,
              entry: lastMeme.entry
            })
            return
          }
          finish(hit)
          return
        }
        // 命中新梗：记住词条与标准接法，供下一轮接龙
        lastMeme = {
          title: hit.title ?? '',
          chain: hit.chain ?? '',
          entry: hit.entry ?? '',
          at: Date.now()
        }
        finish(hit)
      } catch {
        finish(null)
      }
    })
    child.stdin.end(JSON.stringify({ db: MEMES_DB, message }))
  })
}

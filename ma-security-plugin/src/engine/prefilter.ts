// Keyword prefilter: own Aho-Corasick automaton over UTF-16 code units.
// Case folded (ASCII A-Z to a-z on input and keywords). Full DFA in an Int32Array.

export type KeywordHit = {
  /** Index into Automaton.keywords. */
  readonly keyword: number
  /** Start offset in the text (code units). */
  readonly start: number
  /** End offset, exclusive. */
  readonly end: number
}

export interface Automaton {
  /** Unique, lowercased keywords. Index order is stable. */
  readonly keywords: readonly string[]
  /** All hits in text order of end offset. Stops after `limit` hits. */
  scan(text: string, limit?: number): KeywordHit[]
  /** One flag per keyword: 1 when it occurs in text. Cheaper than scan. */
  present(text: string): Uint8Array
}

function fold(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code
}

/** Build the automaton. Empty and duplicate keywords are dropped. Never throws for string input. */
export function buildAutomaton(input: readonly string[]): Automaton {
  const keywords: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    let k = ""
    for (let i = 0; i < raw.length; i++) k += String.fromCharCode(fold(raw.charCodeAt(i)))
    if (k.length === 0 || seen.has(k)) continue
    seen.add(k)
    keywords.push(k)
  }

  // Alphabet: compact symbol ids for the code units used by keywords. 0 = other.
  const symbolOf = new Map<number, number>()
  for (const k of keywords) {
    for (let i = 0; i < k.length; i++) {
      const c = k.charCodeAt(i)
      if (!symbolOf.has(c)) symbolOf.set(c, symbolOf.size + 1)
    }
  }
  const alpha = symbolOf.size + 1
  const charMap = new Int32Array(65536)
  for (const [c, s] of symbolOf) {
    charMap[c] = s
    if (c >= 97 && c <= 122) charMap[c - 32] = s
  }

  // Trie with -1 for missing edges.
  let cap = 64
  let delta = new Int32Array(cap * alpha).fill(-1)
  let states = 1
  const termOf: number[][] = [[]]
  for (let ki = 0; ki < keywords.length; ki++) {
    const k = keywords[ki] as string
    let s = 0
    for (let i = 0; i < k.length; i++) {
      const sym = symbolOf.get(k.charCodeAt(i)) as number
      const idx = s * alpha + sym
      let t = delta[idx] as number
      if (t === -1) {
        if (states === cap) {
          cap *= 2
          const grown = new Int32Array(cap * alpha).fill(-1)
          grown.set(delta)
          delta = grown
        }
        t = states++
        delta[idx] = t
        termOf.push([])
      }
      s = t
    }
    ;(termOf[s] as number[]).push(ki)
  }

  // BFS: fail links, complete the DFA, merge outputs along fail links.
  const fail = new Int32Array(states)
  const queue = new Int32Array(states)
  let head = 0
  let tail = 0
  for (let a = 0; a < alpha; a++) {
    const t = delta[a] as number
    if (t === -1) delta[a] = 0
    else {
      fail[t] = 0
      queue[tail++] = t
    }
  }
  const outs: number[][] = termOf.map((x) => x.slice())
  while (head < tail) {
    const s = queue[head++] as number
    const f = fail[s] as number
    for (const o of outs[f] as number[]) (outs[s] as number[]).push(o)
    for (let a = 0; a < alpha; a++) {
      const idx = s * alpha + a
      const t = delta[idx] as number
      if (t === -1) delta[idx] = delta[f * alpha + a] as number
      else {
        fail[t] = delta[f * alpha + a] as number
        queue[tail++] = t
      }
    }
  }

  // Flatten outputs.
  const outStart = new Int32Array(states + 1)
  let total = 0
  for (let s = 0; s < states; s++) {
    outStart[s] = total
    total += (outs[s] as number[]).length
  }
  outStart[states] = total
  const outList = new Int32Array(total)
  for (let s = 0; s < states; s++) outList.set(outs[s] as number[], outStart[s] as number)
  const klen = Int32Array.from(keywords, (k) => k.length)
  // Premultiplied rows: each cell holds next*alpha (the row offset), so the hot loop
  // drops a multiply. A cell is stored as ~(next*alpha) (negative) when the next state
  // has outputs, so the loop reads outputs only on a hit.
  const table = new Int32Array(states * alpha)
  for (let i = 0; i < states * alpha; i++) {
    const t = delta[i] as number
    const off = t * alpha
    table[i] = (outStart[t + 1] as number) > (outStart[t] as number) ? ~off : off
  }

  return {
    keywords,
    scan(text: string, limit = Number.POSITIVE_INFINITY): KeywordHit[] {
      const hits: KeywordHit[] = []
      if (keywords.length === 0) return hits
      let s = 0
      for (let i = 0; i < text.length; i++) {
        s = table[s + (charMap[text.charCodeAt(i)] as number)] as number
        if (s >= 0) continue
        s = ~s
        const st = s / alpha
        const a = outStart[st] as number
        const b = outStart[st + 1] as number
        for (let j = a; j < b; j++) {
          const ki = outList[j] as number
          hits.push({ keyword: ki, start: i + 1 - (klen[ki] as number), end: i + 1 })
          if (hits.length >= limit) return hits
        }
      }
      return hits
    },
    present(text: string): Uint8Array {
      const flags = new Uint8Array(keywords.length)
      if (keywords.length === 0) return flags
      let s = 0
      for (let i = 0; i < text.length; i++) {
        s = table[s + (charMap[text.charCodeAt(i)] as number)] as number
        if (s >= 0) continue
        s = ~s
        const st = s / alpha
        const a = outStart[st] as number
        const b = outStart[st + 1] as number
        for (let j = a; j < b; j++) flags[outList[j] as number] = 1
      }
      return flags
    },
  }
}

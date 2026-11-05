// Turns Lighthouse CI results (.lighthouseci/lhr-*.json) into a markdown
// section for the sticky preview PR comment.
//
//   node lighthouse-report.mjs [dir] [out.md]
//
// Env: MIN_A11Y (0-100, optional). If set and any URL scores below it, sets
// `a11y_fail=true` in $GITHUB_OUTPUT. Always exits 0 so the comment is posted.
import { readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const CATS = [
  ['performance', 'Perf'],
  ['accessibility', 'A11y'],
  ['best-practices', 'Best practices'],
  ['seo', 'SEO'],
]
const TOP = 5

export function summarize(lhrs, minA11y) {
  const byUrl = new Map()
  for (const l of lhrs) {
    const u = l.finalDisplayedUrl ?? l.finalUrl ?? l.requestedUrl
    if (!byUrl.has(u)) byUrl.set(u, [])
    byUrl.get(u).push(l)
  }
  const rows = []
  const lines = []
  let a11yFail = false
  for (const [url, runs] of byUrl) {
    const score = (id) => {
      const v = runs.map((r) => r.categories?.[id]?.score).filter((s) => typeof s === 'number')
      return v.length ? Math.round((100 * v.reduce((a, b) => a + b, 0)) / v.length) : null
    }
    const s = Object.fromEntries(CATS.map(([id]) => [id, score(id)]))
    if (minA11y != null && (s.accessibility ?? 0) < minA11y) a11yFail = true
    rows.push(`| ${url} | ${CATS.map(([id]) => s[id] ?? 'n/a').join(' | ')} |`)

    // Failing audits, ranked by weighted points lost, from the first run.
    const lhr = runs[0]
    const lost = new Map()
    for (const [, cat] of Object.entries(lhr.categories ?? {})) {
      for (const ref of cat.auditRefs ?? []) {
        const a = lhr.audits?.[ref.id]
        if (!a || typeof a.score !== 'number' || a.score >= 0.9 || !ref.weight) continue
        const pts = ref.weight * (1 - a.score)
        const prev = lost.get(ref.id)
        if (!prev || prev.pts < pts) lost.set(ref.id, { title: a.title, display: a.displayValue, pts, cat: cat.title })
      }
    }
    const top = [...lost.values()].sort((a, b) => b.pts - a.pts).slice(0, TOP)
    if (top.length) {
      lines.push(`<details><summary>Top failing audits for ${url}</summary>`, '')
      for (const t of top) lines.push(`- **${t.title}** (${t.cat})${t.display ? `: ${t.display}` : ''}`)
      lines.push('', '</details>', '')
    }
  }
  const out = [
    '#### Lighthouse',
    '',
    `| URL | ${CATS.map(([, n]) => n).join(' | ')} |`,
    `|---|${CATS.map(() => '---').join('|')}|`,
    ...rows,
    '',
    ...lines,
    minA11y != null
      ? a11yFail
        ? `❌ Accessibility is below the minimum of ${minA11y}.`
        : `Accessibility meets the minimum of ${minA11y}.`
      : '<sub>Report only: this does not block the PR.</sub>',
  ]
  return { md: out.join('\n'), a11yFail }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? '.lighthouseci'
  const outFile = process.argv[3] ?? '/tmp/lighthouse-comment.md'
  const files = readdirSync(dir).filter((f) => /^lhr-.*\.json$/.test(f))
  const lhrs = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  const min = process.env.MIN_A11Y ? Number(process.env.MIN_A11Y) : null
  if (!lhrs.length) {
    writeFileSync(outFile, '#### Lighthouse\n\n⚠️ No Lighthouse results were produced.')
    console.log('no results')
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'a11y_fail=false\n')
  } else {
    const { md, a11yFail } = summarize(lhrs, min)
    writeFileSync(outFile, md)
    console.log(md)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `a11y_fail=${a11yFail}\n`)
  }
}

// 看板技能只从项目自己的技能目录列出、读取。人和助手查看同一份正本，不执行技能里的代码。
// 2026-10-13 起技能只有一份（Agent看板），交接单、看板派工成了它夹里的子文件：子文件也各列一张卡，
// 名字＝文件名去掉 .md，所以技能页、`dispatch skill 看板派工` 照旧找得到。
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

/** 夹里哪些 md 不算一张卡：门牌、考题、下划线开头的。 */
const NOT_A_CARD = /^(00_|考题|_)/;

export function listBoardSkills(root: string) {
  if (!existsSync(root)) return [];
  const realRoot = realpathSync(root);
  const card = (file: string, name: string, descKey: RegExp) => {
    try {
      const rel = relative(realRoot, realpathSync(file));
      if (rel.startsWith('..') || isAbsolute(rel) || statSync(file).size > 128 * 1024) return [];
      const text = readFileSync(file, 'utf8');
      const description = text.match(descKey)?.[1] ?? '点击查看完整说明';
      return [{ name, description, path: file }];
    } catch { return []; }
  };
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .flatMap(d => {
      const dir = join(root, d.name);
      const file = join(dir, 'SKILL.md');
      if (!existsSync(file)) return [];
      const subs = readdirSync(dir, { withFileTypes: true })
        .filter(f => f.isFile() && f.name.endsWith('.md') && f.name !== 'SKILL.md' && !NOT_A_CARD.test(f.name))
        .flatMap(f => card(join(dir, f.name), f.name.replace(/\.md$/, ''), /^这是啥:\s*(.+)$/m));
      return [...card(file, d.name, /^description:\s*(.+)$/m), ...subs];
    });
}
export function readBoardSkill(root: string, name: string) {
  const item = listBoardSkills(root).find(s => s.name === name);
  if (!item) throw new Error('技能不存在，或不在看板技能目录内');
  return { ...item, text: readFileSync(item.path, 'utf8') };
}

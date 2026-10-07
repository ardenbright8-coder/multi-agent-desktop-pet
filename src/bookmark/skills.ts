// 看板技能只从项目自己的技能目录列出、读取。人和助手查看同一份正本，不执行技能里的代码。
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

export function listBoardSkills(root: string) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .flatMap(d => {
      const file = join(root, d.name, 'SKILL.md');
      if (!existsSync(file)) return [];
      try {
        const rel = relative(realpathSync(root), realpathSync(file));
        if (rel.startsWith('..') || isAbsolute(rel) || statSync(file).size > 128 * 1024) return [];
        const text = readFileSync(file, 'utf8');
        const description = text.match(/^description:\s*(.+)$/m)?.[1] ?? '点击查看完整说明';
        return [{ name: d.name, description, path: file }];
      } catch { return []; }
    });
}
export function readBoardSkill(root: string, name: string) {
  const item = listBoardSkills(root).find(s => s.name === name);
  if (!item) throw new Error('技能不存在，或不在看板技能目录内');
  return { ...item, text: readFileSync(item.path, 'utf8') };
}

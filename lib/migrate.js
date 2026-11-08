/**
 * 旧数据目录迁移：`~/.dsh/dsh-companion/` → `~/.dsh/dsh-companion-journal/`。
 *
 * 为什么需要：v0.63 把包名与运行时标识从 `dsh-companion` 改成
 * `dsh-companion-journal`。用户的历史记录、人设、提示词、立绘缓存与热键事件
 * 都在旧目录里，直接换路径等于把「陪伴记录」清空——这正是本插件最不该丢的东西。
 *
 * 迁移规则：
 *   - 新目录已存在：不动旧目录，只告警（两边都有数据时合并风险大于收益）。
 *   - 新目录不存在、旧目录存在：整体 rename（同盘，原子），再尽力在旧路径留一个
 *     指向新目录的符号链接，保证用户已经配好的「快捷指令 → hotkey.events」不失效。
 *   - 旧目录本身已经是指向新目录的符号链接：什么都不做。
 *   - 任何失败都只告警、不抛：迁移不该阻止插件加载。
 *
 * @module dsh-companion-journal/lib/migrate
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** 改名前的运行时目录名（只用于迁移，不要在新代码里引用它做别的）。 */
export const LEGACY_DATA_DIR_NAME = 'dsh-companion';
/** 当前运行时目录名，与包名、bundle id 保持一致。 */
export const DATA_DIR_NAME = 'dsh-companion-journal';

/** DSH 的运行时根目录：优先 DSH_HOME，否则 `~/.dsh`。 */
export function dshHome(env = process.env) {
  return env.DSH_HOME || join(env.HOME || homedir(), '.dsh');
}

/** 旧数据目录的绝对路径。 */
export function legacyDataDir(env = process.env) {
  return join(dshHome(env), LEGACY_DATA_DIR_NAME);
}

/** 当前数据目录的绝对路径。 */
export function dataDir(env = process.env) {
  return join(dshHome(env), DATA_DIR_NAME);
}

/** 旧路径是否已经是指向新目录的符号链接（重复启动时走这条）。 */
function alreadyLinked(legacy, target) {
  try {
    if (!lstatSync(legacy).isSymbolicLink()) return false;
    return resolve(dirname(legacy), readlinkSync(legacy)) === resolve(target);
  } catch {
    return false;
  }
}

/**
 * 执行迁移。
 * @param {{warn?: Function, info?: Function}} [logger]
 * @returns {{ok: boolean, migrated: boolean, reason?: string}}
 */
export function migrateLegacyDataDir(logger = console) {
  const legacy = legacyDataDir();
  const target = dataDir();

  try {
    if (!existsSync(legacy)) return { ok: true, migrated: false, reason: 'no-legacy' };
    if (alreadyLinked(legacy, target)) return { ok: true, migrated: false, reason: 'already-linked' };

    if (existsSync(target)) {
      logger?.warn?.(
        `[dsh-companion-journal] 检测到旧数据目录 ${legacy}，但新目录 ${target} 已存在；` +
          '为避免覆盖，旧目录保持原样，历史记录不会自动合并。',
      );
      return { ok: true, migrated: false, reason: 'target-exists' };
    }

    mkdirSync(dirname(target), { recursive: true });
    renameSync(legacy, target);

    // 旧路径留一个符号链接：用户的 macOS 快捷指令写死了
    // `~/.dsh/dsh-companion/hotkey.events`，不留链接就得让每个人重配。
    try {
      symlinkSync(target, legacy, 'dir');
    } catch (error) {
      logger?.warn?.(
        `[dsh-companion-journal] 已迁移数据，但无法在旧路径建立符号链接（${String(error?.message ?? error)}）；` +
          '如果你用快捷指令触发热键，请把事件文件路径改成新目录。',
      );
    }

    logger?.info?.(`[dsh-companion-journal] 已迁移旧数据：${legacy} → ${target}`);
    return { ok: true, migrated: true, reason: 'migrated' };
  } catch (error) {
    logger?.warn?.(`[dsh-companion-journal] 旧数据迁移失败：${String(error?.message ?? error)}`);
    return { ok: false, migrated: false, reason: String(error?.message ?? error) };
  }
}

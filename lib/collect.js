/**
 * 多画面收集：一次「连续截若干张，再一起看」的会话状态。
 *
 * 设计上的三个刻意的选择：
 *   1. **没有集合分组**：一次收集就是一个集合，从开始到结束，按了多少次 F8 就有多少张。
 *      不需要命名、不需要分类——用户的行为本身就是分组。
 *   2. **张数不设上限**：收集期不调模型，所以收多收少都不花钱；发请求时才做分页（每页 9 张）。
 *   3. **只在内存里**：插件重启即丢，避免「半个集合」这种尴尬状态；已完成的收集会落成历史记录。
 *
 * @module dsh-companion-journal/lib/collect
 */

/**
 * @returns {{active: ()=>boolean, start: Function, add: Function, stop: Function, cancel: Function, items: Function}}
 */
export function createCollection() {
  /** @type {{active: boolean, startedAt: number, items: Array<object>}} */
  let state = { active: false, startedAt: 0, items: [] };

  return {
    active() {
      return state.active;
    },
    startedAt() {
      return state.startedAt;
    },
    items() {
      return state.items.slice();
    },
    /** 开始一次收集（会清空上一次的残留）。 */
    start() {
      state = { active: true, startedAt: Date.now(), items: [] };
      return state.items.length;
    },
    /** 追加一张，返回当前张数。未开始时返回 -1。 */
    add(item) {
      if (!state.active) return -1;
      state.items.push(item);
      return state.items.length;
    },
    /** 结束并取出全部（之后状态清空）。 */
    stop() {
      const items = state.items.slice();
      state = { active: false, startedAt: 0, items: [] };
      return items;
    },
    /** 取消（丢弃）。 */
    cancel() {
      state = { active: false, startedAt: 0, items: [] };
    },
  };
}

/** 每页最多几张图（一次模型调用的上限，避免单次请求过大）。 */
export const PAGE_SIZE = 9;

/** 把一次收集按 PAGE_SIZE 分页。 */
export function paginate(items, size = PAGE_SIZE) {
  const pages = [];
  for (let index = 0; index < items.length; index += size) {
    pages.push(items.slice(index, index + size));
  }
  return pages;
}

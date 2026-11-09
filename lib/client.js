/**
 * 客户端半侧：陪伴记录面板（侧边栏入口 + 主区）与设置页。
 *
 * 形态是用户定的：看的结果在桌宠气泡里，历史在面板里，没有页内常驻胶囊。
 * 本文件不注册任何常驻轮询——面板只在打开期间按需取数据，SSE 随连接回收。
 *
 * 资源全部在 apply 里注册、由 ctx.effect 回收；组件自身不写 DOM。
 * 任何异常都必须被组件吃掉：slot entry 一旦抛错，整个插槽会空掉，
 * 宿主只会在控制台留一行 "slot entry crashed"。
 *
 * @module dsh-companion-journal/lib/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-companion-journal',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /**
     * 这份客户端 bundle 的版本。
     *
     * 用来让宿主判断「页面里的代码是不是旧的」。用户那边没有「刷新页面」这个概念，
     * 只有关闭重启，所以必须由宿主主动在桌宠头顶说一句「有新版本，重启客户端生效」，
     * 否则用户根本不知道自己的界面是旧的。test/client.test.js 会钉住它等于 package.json。
     */
    const CLIENT_VERSION = '1.0.17';

    const HISTORY_URL = '/dsh-companion-journal-8201/history';

    /**
     * 侧边栏图标：一个小人。
     *
     * 必须是内联 SVG 而不是字形（◷ 之类）：栅格字形跟 DSH 自带的线性图标
     * 在基线、粗细、视觉重量上都不一致，排在一列里会明显歪一格。
     * 尺寸取宿主给的 `size`（默认 16），描边 1.8 与官方图标同一档。
     */
    function HistoryIcon(props = {}) {
      const size = Number(props.size) > 0 ? Number(props.size) : 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('circle', { cx: 12, cy: 8.2, r: 3.6 }),
        h('path', { d: 'M5.6 20c0-3.55 2.87-6.1 6.4-6.1s6.4 2.55 6.4 6.1' }),
      );
    }

    const panelStyles = {
      // 面板分两段：头部（搜索 / 统计 / 多选操作）固定，列表自己滚 —— 往下翻时头部不动。
      wrap: { height: '100%', display: 'flex', flexDirection: 'column', fontSize: '13px', lineHeight: '20px' },
      header: {
        flex: '0 0 auto',
        padding: '16px 20px 10px',
        // 用最弱的一档分隔线：冻结区需要一条边界，否则滚起来像是内容叠上去了。
        borderBottom: '1px solid var(--dsw-alias-border-l1, #ddd)',
      },
      scroll: { flex: '1 1 auto', overflowY: 'auto', padding: '4px 20px 16px' },
      bar: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' },
      input: {
        flex: '1 1 220px',
        minWidth: '160px',
        padding: '6px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1, #ddd))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
      },
      /** 追问输入框：做成明显的圆角矩形，让人一眼看出这里可以打字。 */
      composer: {
        flex: '1 1 auto',
        minWidth: '200px',
        padding: '9px 14px',
        borderRadius: '12px',
        // 实色比主题的半透明描边可靠；#b0b5bd 是「看得见但不抢眼」的浅灰。
        border: '1px solid #b0b5bd',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'inherit',
        font: 'inherit',
        outline: 'none',
      },
      /** 缓存命中：按记录聚合，放在讨论区底部。 */
      cache: {
        marginTop: '8px',
        fontSize: '12px',
        opacity: 0.7,
        display: 'flex',
        gap: '10px',
        alignItems: 'center',
      },
      /**
       * 小按钮/胶囊。之前用实色 border-l1 + 深色描边，在浅色底上像「凸台」；
       * 现在改成半透明中性描边、无阴影、无背景，靠文字色表达层级。
       */
      chip: (active) => ({
        padding: '4px 10px',
        borderRadius: '999px',
        cursor: 'pointer',
        border: active ? '1px solid transparent' : '1px solid rgba(128,128,128,0.32)',
        boxShadow: 'none',
        background: active ? 'var(--dsw-alias-brand-primary, #4c8dff)' : 'transparent',
        color: active ? '#fff' : 'inherit',
        font: 'inherit',
        lineHeight: '16px',
      }),
      /** 每条记录一张卡：靠背景与圆角区隔，比一条细分割线更容易扫读。 */
      item: {
        display: 'flex',
        // 关键：默认 stretch 会把缩略图拉到和整行一样高（展开讨论后尤其明显）。
        alignItems: 'flex-start',
        gap: '12px',
        padding: '12px',
        marginBottom: '10px',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        border: '1px solid var(--dsw-alias-border-l1, #ddd))',
      },
      /** 角色色条：我=强调色，它=中性色，扫一眼就知道哪句是谁说的。 */
      /** 角色色条：我=蓝，它=绿（固定色，不跟随主题，保证两边都看得见）。 */
      turn: (role) => ({
        // 问与答之间留一整行空白的呼吸感：8px 太挤，看起来像同一段。
        marginTop: '18px',
        marginBottom: '6px',
        paddingLeft: '10px',
        borderLeft: `2px solid ${role === 'user' ? '#4c8dff' : '#3fb950'}`,   // 3px → 2px（细 1/3）
      }),
      turnLabel: (role) => ({
        fontSize: '11px',
        lineHeight: '14px',
        marginBottom: '2px',
        fontWeight: 600,
        color: role === 'user' ? '#4c8dff' : '#3fb950',
      }),
      meta: { opacity: 0.65, fontSize: '12px' },
      /** 走文字抓取时，把当时喂给模型的原文也显示出来（截图有缩略图，文字没有凭证）。 */
      quote: {
        marginTop: '6px',
        paddingLeft: '10px',
        borderLeft: '2px solid #4c8dff',
        opacity: 0.9,
        whiteSpace: 'pre-wrap',
        fontSize: '12.5px',
        lineHeight: '19px',
      },
      quoteMore: {
        marginTop: '2px',
        paddingLeft: '10px',
        fontSize: '11px',
        opacity: 0.6,
        cursor: 'pointer',
      },
      q: { marginTop: '4px', opacity: 0.85 },
      body: { marginTop: '4px', whiteSpace: 'pre-wrap' },
      thumb: {
        width: '132px',
        height: 'auto',
        alignSelf: 'flex-start',
        borderRadius: '6px',
        objectFit: 'cover',
        flex: '0 0 auto',
        display: 'block',
      },
      /** 大图层的左右切换按钮：半透明、压在图片两侧，不抢视线。 */
      zoomArrow: (dir, disabled) => ({
        position: 'absolute',
        top: '50%',
        [dir < 0 ? 'left' : 'right']: '20px',
        transform: 'translateY(-50%)',
        width: '46px',
        height: '46px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        paddingBottom: '4px',
        borderRadius: '50%',
        border: '1px solid rgba(255,255,255,0.26)',
        background: 'rgba(255,255,255,0.16)',
        color: '#fff',
        fontSize: '30px',
        lineHeight: '1',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.22 : 1,
        userSelect: 'none',
      }),
      zoomCounter: {
        position: 'absolute',
        bottom: '22px',
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '2px 10px',
        borderRadius: '999px',
        background: 'rgba(0,0,0,0.5)',
        color: 'rgba(255,255,255,0.9)',
        fontSize: '12.5px',
        lineHeight: '18px',
        pointerEvents: 'none',
      },
      danger: { marginTop: '20px', paddingTop: '14px', borderTop: '1px solid var(--dsw-alias-border-l1, #ddd))' },
      /**
       * 右键菜单的透明遮罩：用一整层 fixed 元素接住「点空白处」，
       * 比在 document 上挂监听更不容易漏掉滚动、切窗口之类的关闭时机。
       */
      contextLayer: { position: 'fixed', inset: 0, zIndex: 9997 },
      /** 菜单本体：定位取右键那一刻的屏幕坐标，颜色全部走主题变量。 */
      contextMenu: {
        position: 'fixed',
        minWidth: '120px',
        padding: '4px',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-overlay, transparent)',
        border: '1px solid var(--dsw-alias-border-l1)',
        // 用中性灰而不是黑：浅色/深色主题下都不会显得太脏。
        boxShadow: '0 10px 30px rgba(127,127,127,0.28)',
        zIndex: 9998,
      },
      /** 菜单项整行可点；背景保持透明，交给宿主的主题层去衬托。 */
      contextMenuItem: {
        display: 'block',
        width: '100%',
        padding: '7px 12px',
        border: 'none',
        borderRadius: '7px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
    };

    /** 时间戳 → 本地日期：`2026-10-30T16:00:00.000Z` → `2026-10-31`。 */
    function localDate(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    /** 容量格式化：<1GB 用 MB，≥1GB 用 GB（与宿主端同一口径）。 */
    function fmtBytes(bytes) {
      const value = Math.max(0, Number(bytes) || 0);
      const gb = value / 1024 ** 3;
      return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
    }

    function rangeOf(kind) {
      const now = new Date();
      // 按**本地时区**的当天 0 点切分，并且传完整时间戳（而不是日期字符串）：
      // 日期字符串会被 Date.parse 当成 UTC，东八区下「今天」会混进昨天的记录（实测）。
      const startOfDay = (date) => {
        const copy = new Date(date);
        copy.setHours(0, 0, 0, 0);
        return copy;
      };
      const iSO = (date) => date.toISOString();
      const endOfToday = () => new Date(startOfDay(now).getTime() + 86_400_000 - 1);
      if (kind === 'today') return { from: iSO(startOfDay(now)), to: iSO(endOfToday()) };
      if (kind === '7d') {
        return { from: iSO(startOfDay(new Date(now.getTime() - 6 * 86_400_000))), to: iSO(endOfToday()) };
      }
      if (kind === '30d') {
        return { from: iSO(startOfDay(new Date(now.getTime() - 29 * 86_400_000))), to: iSO(endOfToday()) };
      }
      return { from: '', to: '' };
    }

    /** 一条记录里的图片数：多画面看 images，单画面就是 1。 */
    function imageCount(item) {
      return Array.isArray(item?.images) && item.images.length > 0 ? item.images.length : 1;
    }

    /** token 估算值：按量级自动换单位（与 lib/watch.js 的 formatTokens 保持一致）。 */
    function fmtTokens(value) {
      const n = Math.max(0, Math.round(Number(value) || 0));
      if (n < 1000) return String(n);
      if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
      if (n < 995_000) return `${Math.round(n / 1000)}k`;
      return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
    }

    /** 看一阵的时间线用 mm:ss。 */
    function clockOf(ms) {
      const total = Math.max(0, Math.round(Number(ms ?? 0) / 1000));
      return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }

    /** 把缩略图索引夹到 [0, count-1]：旧记录没有 thumbIndex，也走这条。 */
    function clampIndex(item, index) {
      const count = imageCount(item);
      const n = Number.isFinite(index) ? Math.trunc(index) : 0;
      return Math.max(0, Math.min(count - 1, n));
    }

    function HistoryPanel() {
      const [data, setData] = React.useState(null);
      const [q, setQ] = React.useState('');
      const [range, setRange] = React.useState('7d');
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState('');
      /** 点开的原图记录；null = 没有放大层。thumbIndex = 记录里的第几张。 */
      const [zoom, setZoom] = React.useState(null);
      const [gallery, setGallery] = React.useState(null);
      /** 看一阵的拼图大图：{ url, label } | null。 */
      const [sheetView, setSheetView] = React.useState(null);

      // 大图的键盘操作：←/→ 切上一张/下一张，Esc 关闭。监听跟着放大层走，
      // 没有放大层时不挂任何监听（空闲期零开销）。
      React.useEffect(() => {
        if (!sheetView) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setSheetView(null);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [sheetView]);

      React.useEffect(() => {
        if (!zoom) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setZoom(null);
            return;
          }
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          if (imageCount(zoom) <= 1) return;
          event.preventDefault();
          const step = event.key === 'ArrowLeft' ? -1 : 1;
          const next = clampIndex(zoom, clampIndex(zoom, zoom.thumbIndex) + step);
          setZoom((current) => (current ? { ...current, thumbIndex: next } : current));
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [zoom]);
      /** 行内手风琴：同时只展开一条。 */
      const [expanded, setExpanded] = React.useState(null);
      /** 点桌宠气泡后要定位到的记录：展开并滚到可视区。 */
      const [focusId, setFocusId] = React.useState('');
      const [draft, setDraft] = React.useState('');
      const [sending, setSending] = React.useState(false);
      /** 本地线程覆盖（发送后立刻显示，不用整页刷新）。 */
      const [threads, setThreads] = React.useState({});
      /** 失败时保留「要重发的那一条」，给一个明确的重试入口。 */
      const [retry, setRetry] = React.useState(null);
      /** 待开新会话的记录：非 null 时显示模式选择弹窗（同时充当二次确认）。 */
      const [spawnFor, setSpawnFor] = React.useState(null);
      /** 多选模式下选中的记录 id（只属于多选模式，退出时清空）。 */
      const [picked, setPicked] = React.useState([]);
      /** 多选模式：由卡片右键菜单进入；进入后整张卡都可点选。 */
      const [selectMode, setSelectMode] = React.useState(false);
      /** 卡片右键菜单：屏幕坐标 + 目标记录 id；null = 关闭。 */
      const [contextMenu, setContextMenu] = React.useState(null);
      /** 工作区列表与当前选择：新会话必须挂在某个工作区里才看得见。 */
      const [workspaces, setWorkspaces] = React.useState([]);
      const [workspaceId, setWorkspaceId] = React.useState('');
      /** 新建会话用的模式（DSH 的 agent preset：标准 / PTC / 极简 / 创造…）。 */
      const [presets, setPresets] = React.useState([]);
      const [presetId, setPresetId] = React.useState('');

      const load = React.useCallback(async () => {
        const r = rangeOf(range);
        const params = new URLSearchParams({ q, limit: '200' });
        if (r.from) params.set('from', r.from);
        if (r.to) params.set('to', r.to);
        try {
          const response = await fetch(`${HISTORY_URL}?${params.toString()}`, { cache: 'no-store' });
          const payload = await response.json();
          setData(payload);
        } catch (error) {
          setNote(`读取失败：${String(error?.message ?? error)}`);
        }
      }, [q, range]);

      React.useEffect(() => {
        void load();
      }, [load]);

      // 面板挂载时取一次 pending（覆盖「面板本来是关着的」这种情况）；
      // 之后再靠 SSE 的事件，不做轮询。
      React.useEffect(() => {
        const applyPending = (id) => {
          if (!id) return;
          setExpanded(id);
          setFocusId(id);
        };
        void (async () => {
          try {
            const response = await fetch('/dsh-companion-journal-8201/buddy/consume', { method: 'POST' });
            const payload = await response.json();
            applyPending(String(payload?.recordId ?? ''));
          } catch {
            /* 没有 pending 是正常的 */
          }
        })();
        const onFocus = (event) => applyPending(String(event?.detail ?? ''));
        window.addEventListener('dsh-companion-journal:focus-record', onFocus);
        return () => window.removeEventListener('dsh-companion-journal:focus-record', onFocus);
      }, []);

      React.useEffect(() => {
        void (async () => {
          try {
            const response = await fetch('/dsh-companion-journal-8201/presets', { cache: 'no-store' });
            const payload = await response.json();
            const items = Array.isArray(payload?.items) ? payload.items : [];
            setPresets(items);
            // 记住上次选的模式，别每次回到默认（和 DSH 的「最近使用」直觉一致）。
            setPresetId((current) => {
              if (current) return current;
              let remembered = '';
              try {
                // 旧键只读回退：改名不该让用户丢掉上次选的模式。
                remembered =
                  window.localStorage.getItem('dsh-companion-journal.preset') ||
                  window.localStorage.getItem('dsh-companion.preset') ||
                  '';
              } catch {
                remembered = '';
              }
              if (remembered && items.some((item) => item.id === remembered)) return remembered;
              return items[0]?.id || '';
            });
          } catch {
            /* 拿不到就退化为宿主默认 preset */
          }
        })();
      }, []);

      React.useEffect(() => {
        void (async () => {
          try {
            const response = await fetch('/dsh-companion-journal-8201/workspaces', { cache: 'no-store' });
            const payload = await response.json();
            const items = Array.isArray(payload?.items) ? payload.items : [];
            setWorkspaces(items);
            setWorkspaceId((current) => current || items[0]?.id || '');
          } catch {
            /* 拿不到就退化为宿主默认工作区 */
          }
        })();
      }, []);

      const ask = React.useCallback(
        async (record, override) => {
          const question = (override ?? draft).trim();
          if (question === '' || sending) return;
          setSending(true);
          setNote('');
          setRetry(null);
          try {
            const response = await fetch('/dsh-companion-journal-8201/history/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: record.id, question }),
            });
            const result = await response.json();
            if (!result.ok) {
              setNote(`追问失败：${result.reason ?? ''}`);
              setRetry({ record, question });
            } else {
              setThreads((prev) => ({ ...prev, [record.id]: result.thread ?? [] }));
              // 只在草稿没被改动时清空：发送后你改成别的问题，不该被吞掉。
              setDraft((current) => (current.trim() === question ? '' : current));
              const usage = result.usage ?? {};
              setNote(`本轮 ${usage.input ?? '?'} 输入 / ${usage.output ?? '?'} 输出 token（缓存命中 ${usage.cacheRead ?? 0}）`);
            }
          } catch (error) {
            setNote(`追问失败：${String(error?.message ?? error)}`);
            setRetry({ record, question });
          } finally {
            setSending(false);
          }
        },
        [draft, sending],
      );

      const spawnSession = React.useCallback(
        async (record) => {
          // 拿不到工作区列表时仍然允许创建：由宿主按默认工作区处理，
          // 否则弹窗里点「创建」会毫无反应。
          const ws = workspaces.find((item) => item.id === workspaceId) ?? { id: '', path: '', title: '默认工作区' };
          setBusy(true);
          setNote('');
          try {
            const response = await fetch('/dsh-companion-journal-8201/history/spawn', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: record.id, cwd: ws?.path ?? '', agentPreset: presetId || undefined }),
            });
            const result = await response.json();
            setNote(
              result.ok
                ? `已创建会话 ${result.sessionId}（${result.workspace?.title ?? result.cwd}）${result.withImage ? '，已带原图' : ''}，在左侧会话列表里打开`
                : `创建失败：${result.reason ?? ''}`,
            );
          } catch (error) {
            setNote(`创建失败：${String(error?.message ?? error)}`);
          } finally {
            setBusy(false);
          }
        },
        [workspaces, workspaceId, presetId],
      );

      const removeIds = React.useCallback(
        async (ids) => {
          if (!Array.isArray(ids) || ids.length === 0) return false;
          if (!window.confirm(`删除 ${ids.length} 条记录（含截图与讨论）？`)) return false;
          setBusy(true);
          try {
            const response = await fetch('/dsh-companion-journal-8201/history/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids }),
            });
            const result = await response.json();
            setNote(result.ok ? `已删除 ${result.removed} 条（${result.images} 张图），剩余 ${result.kept} 条` : `删除失败：${result.reason ?? ''}`);
            if (result.ok) {
              // 只把删掉的 id 从选中集合里拿掉：多选模式可能还留着别的选择。
              setPicked((prev) => prev.filter((id) => !ids.includes(id)));
              await load();
            }
            // 把结果交给调用方：多选删除要等真正成功后再退出模式。
            return Boolean(result.ok);
          } catch (error) {
            setNote(`删除失败：${String(error?.message ?? error)}`);
            return false;
          } finally {
            setBusy(false);
          }
        },
        [load],
      );

      /** 多选模式里的单条开关：卡片和标题共用，避免两处逻辑漂移。 */
      const togglePicked = (id) => {
        setPicked((prev) => (prev.includes(id) ? prev.filter((itemId) => itemId !== id) : [...prev, id]));
      };

      /** 取消选择 = 清空选中并退出多选模式，右键菜单也一并收起。 */
      const leaveSelectMode = () => {
        setPicked([]);
        setSelectMode(false);
        setContextMenu(null);
      };

      /** 从右键菜单进入多选；默认把触发菜单的那条先选上，少一次点击。 */
      const enterSelectMode = (id) => {
        setContextMenu(null);
        // 收起已展开的讨论：否则整卡点选会撞上输入框和发送按钮。
        setExpanded(null);
        setSelectMode(true);
        setPicked((prev) => (prev.includes(id) ? prev : [...prev, id]));
      };

      /** 右键菜单按屏幕坐标定位，并在靠近视口边缘时向内收。 */
      const openContextMenu = (event, itemId) => {
        event.preventDefault();
        event.stopPropagation();
        const margin = 8;
        // 菜单尺寸没有测量，取一个足够覆盖「多选」单项的估值即可。
        const width = 132;
        const height = 48;
        const maxX = Math.max(margin, Number(window.innerWidth || 0) - width - margin);
        const maxY = Math.max(margin, Number(window.innerHeight || 0) - height - margin);
        setContextMenu({
          x: Math.min(Math.max(event.clientX, margin), maxX),
          y: Math.min(Math.max(event.clientY, margin), maxY),
          itemId,
        });
      };

      const deletePicked = React.useCallback(async () => {
        if (picked.length === 0) return;
        const removed = await removeIds(picked);
        // 取消确认或删除失败时留在多选模式，保留选择方便重试。
        if (removed) leaveSelectMode();
      }, [picked, removeIds]);

      const cleanup = React.useCallback(
        async (mode) => {
          const r = rangeOf(range);
          if (!r.from && !r.to) {
            setNote('清理需要先选一个时间范围（今天/7天/30天）');
            return;
          }
          const label = mode === 'images' ? '只删除这个范围内的截图（保留文字与问答）' : '删除这个范围内的全部记录（含截图）';
          if (!window.confirm(`${label}？`)) return;
          setBusy(true);
          try {
            const response = await fetch('/dsh-companion-journal-8201/history/cleanup', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ from: r.from, to: r.to, mode }),
            });
            const result = await response.json();
            setNote(result.ok ? `已清理：${result.removed} 条记录、${result.images} 张图，剩余 ${result.kept} 条` : `清理失败：${result.reason ?? ''}`);
            await load();
          } catch (error) {
            setNote(`清理失败：${String(error?.message ?? error)}`);
          } finally {
            setBusy(false);
          }
        },
        [range, load],
      );

      const items = data?.items ?? [];
      const stats = data?.stats ?? { total: 0, apps: [] };
      // 右键菜单项保持为数组：以后加「开新会话」之类的操作只需往这里追加。
      const contextActions = contextMenu
        ? [
            {
              id: 'multi',
              label: '多选',
              run: () => enterSelectMode(contextMenu.itemId),
            },
          ]
        : [];

      return h(
        'div',
        { style: panelStyles.wrap },
        h(
          'div',
          { style: panelStyles.header },
        h(
          'div',
          { style: panelStyles.bar },
          h('input', {
            style: panelStyles.input,
            placeholder: '搜索标题 / 画面文字 / 问题 / 回答',
            value: q,
            onChange: (e) => setQ(e.target.value),
          }),
          ...[
            ['today', '今天'],
            ['7d', '7 天'],
            ['30d', '30 天'],
            ['all', '全部'],
          ].map(([kind, label]) => h('button', { key: kind, style: panelStyles.chip(range === kind), onClick: () => setRange(kind) }, label)),
        ),
        h(
          'div',
          { style: panelStyles.meta },
          `共 ${data?.total ?? 0} 条 · 当前范围缓存 ${data?.rangeSize ?? '0.0 MB'}（全部 ${fmtBytes(data?.diskBytes)}）`,
        ),
        selectMode
          ? h(
              'div',
              {
                style: {
                  ...panelStyles.bar,
                  marginTop: '-4px',
                  // 多选操作放右上角：不挤占记录列表的阅读起点。
                  justifyContent: 'flex-end',
                },
              },
              h('span', { style: panelStyles.meta }, `已选 ${picked.length} 条`),
              h('button', { style: panelStyles.chip(false), onClick: leaveSelectMode }, '取消选择'),
              h(
                'button',
                {
                  style: { ...panelStyles.chip(true), opacity: busy || picked.length === 0 ? 0.6 : 1 },
                  disabled: busy || picked.length === 0,
                  onClick: () => void deletePicked(),
                },
                '删除选中',
              ),
            )
          : null,
        ),
        h(
          'div',
          { style: panelStyles.scroll },
        note
          ? h(
              'div',
              { style: { ...panelStyles.q, color: '#e0a030', display: 'flex', gap: '8px', alignItems: 'center' } },
              h('span', null, note),
              retry
                ? h(
                    'button',
                    {
                      style: panelStyles.chip(false),
                      disabled: sending,
                      onClick: () => {
                        setExpanded(retry.record.id);
                        void ask(retry.record, retry.question);
                      },
                    },
                    '重发',
                  )
                : null,
            )
          : null,
        items.length === 0
          ? h('div', { style: { ...panelStyles.meta, padding: '24px 0' } }, '这个范围内还没有记录。按热键看一眼就会出现在这里。')
          : items.map((item) => {
              const selectedHere = selectMode && picked.includes(item.id);
              const cardImages = Array.isArray(item.images) ? item.images : [];
              return h(
                'div',
                {
                  key: item.id,
                  // 非多选模式下整卡不响应点击（只有标题可展开）；多选模式才由整卡接管选中。
                  style: {
                    ...panelStyles.item,
                    // 纵向：上面一行是「缩略图 + 文字」，展开的宫格独占下面一整行。
                    // 放在横排里的话，3 列宫格会把文字列挤到右边（用户实测的「缩进不对」）。
                    flexDirection: 'column',
                    alignItems: 'stretch',
                    ...(selectMode ? { cursor: 'pointer' } : null),
                    // 半透明强调色叠加在卡片原背景上，深浅主题都能保留原有边框与圆角。
                    ...(selectedHere ? { background: 'rgba(76,141,255,0.10)' } : null),
                  },
                  onClick: selectMode ? () => togglePicked(item.id) : undefined,
                  onContextMenu: (event) => openContextMenu(event, item.id),
                  ref: (node) => {
                    if (node && item.id === focusId) {
                      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    }
                  },
                },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'flex-start', gap: '12px', minWidth: 0 } },
                (() => {
                  // 多画面记录：显示第一张 + 「+N」角标；点开在卡片内展开网格。
                  // 索引必须按记录里 images 的原始顺序算：先 filter 再取下标，
                  // 一旦有条目缺缩略图，大图就会对错号。
                  const images = Array.isArray(item.images) ? item.images : [];
                  const first = item.thumb ? item : images.find((one) => one && one.thumb);
                  if (!first) return null;
                  const total = images.length > 0 ? images.length : 1;
                  // 多画面记录即使只截到一张，也仍然是 multi：点它应当直接看大图，
                  // 而不是因为 total === 1 被当成「没有图」。
                  const isMulti = item.kind === 'multi' || images.length > 1;
                  const canZoom = images.length > 0 || Boolean(item.image);
                  const expandedHere = gallery === item.id;
                  return h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                    h(
                      'div',
                      { style: { position: 'relative', width: 'fit-content' } },
                      h('img', {
                        style: {
                          ...panelStyles.thumb,
                          cursor: selectMode ? 'pointer' : canZoom ? 'zoom-in' : 'default',
                        },
                        src: `/dsh-companion-journal-8201/history/thumb/${encodeURIComponent(item.id)}`,
                        alt: '',
                        onClick: (event) => {
                          event.stopPropagation();
                          if (selectMode) {
                            togglePicked(item.id);
                            return;
                          }
                          // 多张：先在卡片内展开；只有一张（含多画面但只截到一张）：
                          // 直接看大图。单画面记录走 item.image 那条。
                          if (total > 1) setGallery(expandedHere ? null : item.id);
                          else if (canZoom) setZoom(isMulti ? { ...item, thumbIndex: 0 } : item);
                        },
                      }),
                      total > 1
                        ? h(
                            'span',
                            {
                              style: {
                                position: 'absolute',
                                right: '4px',
                                bottom: '4px',
                                padding: '1px 6px',
                                borderRadius: '9px',
                                background: 'rgba(0,0,0,0.62)',
                                color: '#fff',
                                fontSize: '10.5px',
                                lineHeight: '15px',
                                pointerEvents: 'none',
                              },
                            },
                            `+${total}`,
                          )
                        : null,
                    ),
                  );
                })(),
                h(
                  'div',
                  { style: { flex: '1 1 auto', minWidth: '0' } },
                  h(
                    'div',
                    // 标题可能换行：动作列与标题**第一行**顶对齐。
                    { style: { display: 'flex', alignItems: 'flex-start', gap: '8px' } },
                    h(
                      'div',
                      {
                        // 非多选时只有标题文字能展开；多选时标题跟整卡一样切换选中。
                        style: { ...panelStyles.meta, flex: '1 1 0', minWidth: 0, cursor: 'pointer' },
                        title: selectMode ? '点击选择 / 取消选择' : expanded === item.id ? '点击收起' : '点击展开讨论',
                        onClick: (event) => {
                          event.stopPropagation();
                          if (selectMode) {
                            togglePicked(item.id);
                            return;
                          }
                          setExpanded(expanded === item.id ? null : item.id);
                        },
                      },
                      `${new Date(item.at).toLocaleString()} · ${item.app || '未知'}${item.title ? `「${item.title}」` : ''}`,
                    ),
                    // 动作列固定宽度并右对齐：标题的最大长度因此稳定，与上方搜索框的右缘一致，
                    // 不会因为按钮文案长短让每行换行位置都不一样。
                    h(
                      'div',
                      {
                        style: {
                          display: 'flex',
                          gap: '8px',
                          flex: '0 0 auto',
                          minWidth: '150px',
                          justifyContent: 'flex-end',
                          // 两个控件（开新会话 / 删除）在一条水平线上。
                          alignItems: 'center',
                        },
                      },
                      h(
                        'button',
                        {
                          style: { ...panelStyles.chip(false), padding: '3px 10px', fontSize: '11px', lineHeight: '16px', flex: '0 0 auto' },
                          title: '用这条记录开一个新会话（带原图）',
                          disabled: busy,
                          onClick: (event) => {
                            event.stopPropagation();
                            setSpawnFor(item);
                          },
                        },
                        '开新会话',
                      ),
                      h(
                        'button',
                        {
                          style: { ...panelStyles.chip(false), padding: '3px 10px', fontSize: '11px', lineHeight: '16px', flex: '0 0 auto' },
                          title: '删除这条记录',
                          onClick: (event) => {
                            event.stopPropagation();
                            void removeIds([item.id]);
                          },
                        },
                        '删除',
                      ),
                    ),
                  ),
                  (() => {
                    // 截图记录有缩略图当凭证；文字记录以前只有评语，看不到「当时喂了什么」。
                    // 多画面记录的 text 是合并后的 OCR，只在搜索里用，不该当成「选中的文字」展示。
                    if (item.kind === 'multi') return null;
                    const raw = String(item.text ?? '');
                    if (!raw) return null;
                    const expandedHere = expanded === item.id;
                    const limit = 260;
                    const clipped = !expandedHere && raw.length > limit;
                    return h(
                      'div',
                      { style: { marginTop: '4px' } },
                      h('div', { style: panelStyles.turnLabel('user') }, '选中的文字'),
                      h('div', { style: panelStyles.quote }, clipped ? `${raw.slice(0, limit)}…` : raw),
                      clipped
                        ? h(
                            'div',
                            {
                              style: panelStyles.quoteMore,
                              onClick: (event) => {
                                event.stopPropagation();
                                // 多选模式下所有卡片内部入口都让位给选中，避免误展开。
                                if (selectMode) {
                                  togglePicked(item.id);
                                  return;
                                }
                                setExpanded(item.id);
                              },
                            },
                            `展开全文（${raw.length} 字）`,
                          )
                        : null,
                    );
                  })(),
                  item.question ? h('div', { style: panelStyles.q }, `Q：${item.question}`) : null,
                  h(
                    'div',
                    { style: panelStyles.turn('assistant') },
                    h('div', { style: panelStyles.turnLabel('assistant') }, '它'),
                    h('div', { style: panelStyles.body }, item.answer),
                    // 看一阵：时间线折叠在卡片里（默认收起）。
                    item.kind === 'watch' && Array.isArray(item.timeline) && item.timeline.length > 0
                      ? h(
                          'details',
                          { style: { marginTop: '8px' } },
                          h(
                            'summary',
                            { style: { ...panelStyles.meta, cursor: 'pointer' } },
                            `看了一阵 ${item.stats?.windows ?? item.timeline.length} 段 · ${fmtTokens(item.stats?.estTokens)} token · ${item.stats?.needsVisualWindows ?? 0} 段没看画面`,
                          ),
                          h(
                            'div',
                            { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' } },
                            ...item.timeline.map((win, index) =>
                              h(
                                'div',
                                {
                                  key: index,
                                  style: { ...panelStyles.meta, display: 'flex', gap: '8px', opacity: win.gap ? 0.45 : 1 },
                                },
                                h('span', { style: { flex: '0 0 auto', opacity: 0.7 } }, `${clockOf(win.start)}–${clockOf(win.end)}`),
                                h(
                                  'span',
                                  { style: { flex: '1 1 auto', minWidth: 0 } },
                                  `${win.summary || '（这一段没有内容）'}${
                                    win.needsVisual && !win.sheet ? '（这段没看画面）' : ''
                                  }${win.visualReason === 'motion' && win.sheet ? '（画面变化大，已看图）' : ''}`,
                                ),
                                win.sheet
                                  ? h(
                                      'button',
                                      {
                                        type: 'button',
                                        style: { ...panelStyles.chip(false), flex: '0 0 auto', padding: '2px 8px', fontSize: '11px' },
                                        onClick: (event) => {
                                          event.stopPropagation();
                                          setSheetView({
                                            url: `/dsh-companion-journal-8201/history/image/${encodeURIComponent(item.id)}?sheet=${index}`,
                                            label: `${clockOf(win.start)}–${clockOf(win.end)}`,
                                          });
                                        },
                                      },
                                      '画面',
                                    )
                                  : null,
                              ),
                            ),
                          ),
                        )
                      : null,
                  ),
                  (() => {
                    const thread = threads[item.id] ?? item.thread ?? [];
                    if (expanded !== item.id) {
                      // 入口必须**无条件显示**：以前只有「已经追问过」的记录才出现这一行，
                      // 没追问过的记录没有任何可见入口，看起来就像追问功能消失了（用户实测反馈）。
                      return h(
                        'div',
                        {
                          style: { ...panelStyles.meta, cursor: 'pointer' },
                          onClick: (event) => {
                            event.stopPropagation();
                            if (selectMode) {
                              togglePicked(item.id);
                              return;
                            }
                            setExpanded(item.id);
                          },
                        },
                        thread.length > 0 ? `· ${thread.length / 2} 轮讨论（点开继续）` : '· 追问（点开继续）',
                      );
                    }
                    return h(
                      'div',
                      {
                        style: {
                          marginTop: '10px',
                          paddingTop: '10px',
                          borderTop: '1px dashed var(--dsw-alias-border-l1, #ddd))',
                        },
                        onClick: (event) => event.stopPropagation(),
                      },
                      h(
                        'div',
                        { style: { maxHeight: '50vh', overflowY: 'auto', paddingRight: '4px' } },
                        thread.map((turn, index) =>
                          h(
                            'div',
                            { key: index, style: panelStyles.turn(turn.role === 'assistant' ? 'assistant' : 'user') },
                            h('div', { style: panelStyles.turnLabel(turn.role === 'assistant' ? 'assistant' : 'user') }, turn.role === 'assistant' ? '它' : '我'),
                            h('div', { style: panelStyles.body }, turn.text),
                          ),
                        ),
                      ),
                      h(
                        'div',
                        { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
                        h('input', {
                          style: panelStyles.composer,
                          placeholder: '接着这条继续问（例如：这段为什么会被挑？）',
                          value: draft,
                          onChange: (event) => setDraft(event.target.value),
                          onKeyDown: (event) => {
                            if (event.key === 'Enter') void ask(item);
                          },
                        }),
                        h('button', { style: panelStyles.chip(true), disabled: sending, onClick: () => void ask(item) }, sending ? '思考中…' : '发送'),
                      ),
                      (() => {
                        // 缓存命中按这条记录聚合：取最近一次带 usage 的回答。
                        const withUsage = thread.filter((t) => t && t.usage).slice(-1)[0];
                        if (!withUsage) return null;
                        const u = withUsage.usage;
                        // cacheRead 是「命中缓存的那部分输入」，与未命中的 inputTokens 是并列的，
                        // 所以总输入 = input + cacheRead，命中率也按这个分母算（否则会超过 100%）。
                        const uncached = Number(u.input ?? 0);
                        const cache = Number(u.cacheRead ?? 0);
                        const totalInput = uncached + cache;
                        const rate = totalInput > 0 ? Math.min(100, Math.round((cache / totalInput) * 100)) : 0;
                        return h(
                          'div',
                          { style: panelStyles.cache },
                          h('span', null, `缓存命中 ${rate}%`),
                          h('span', null, `输入 ${totalInput} / 输出 ${Number(u.output ?? 0)} token`),
                        );
                      })(),
                    );
                  })(),
                ),
                ),
                gallery === item.id && cardImages.length > 1
                  ? h(
                      'div',
                      {
                        style: {
                          display: 'grid',
                          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                          gap: '6px',
                          marginTop: '10px',
                        },
                      },
                      cardImages.map((one, index) =>
                        !one || !one.thumb
                          ? null
                          : h('img', {
                              key: index,
                              src: `/dsh-companion-journal-8201/history/thumb/${encodeURIComponent(item.id)}?index=${index}`,
                              alt: '',
                              style: { ...panelStyles.thumb, width: '100%', height: 'auto', cursor: 'zoom-in' },
                              onClick: (event) => {
                                event.stopPropagation();
                                if (selectMode) {
                                  togglePicked(item.id);
                                  return;
                                }
                                setZoom({ ...item, image: one.image || item.image, thumbIndex: index });
                              },
                            }),
                      ),
                    )
                  : null,
              );
            }),
        contextMenu
          ? h(
              'div',
              {
                style: panelStyles.contextLayer,
                // 透明遮罩接住所有空白处点击：菜单本身会阻止冒泡，点菜单项不会误关。
                onClick: () => setContextMenu(null),
                onContextMenu: (event) => {
                  event.preventDefault();
                  setContextMenu(null);
                },
              },
              h(
                'div',
                {
                  style: {
                    ...panelStyles.contextMenu,
                    left: `${contextMenu.x}px`,
                    top: `${contextMenu.y}px`,
                  },
                  onClick: (event) => event.stopPropagation(),
                  onContextMenu: (event) => event.preventDefault(),
                },
                contextActions.map((action) =>
                  h(
                    'button',
                    {
                      key: action.id,
                      type: 'button',
                      style: panelStyles.contextMenuItem,
                      onClick: action.run,
                    },
                    action.label,
                  ),
                ),
              ),
            )
          : null,
        spawnFor
          ? h(
              'div',
              {
                style: {
                  position: 'fixed',
                  inset: 0,
                  background: 'rgba(0,0,0,0.55)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 9998,
                },
                onClick: () => !busy && setSpawnFor(null),
              },
              h(
                'div',
                {
                  onClick: (event) => event.stopPropagation(),
                  style: {
                    width: '380px',
                    maxWidth: '90vw',
                    padding: '18px 20px',
                    borderRadius: '14px',
                    background: 'var(--dsw-alias-bg-overlay, #fff)',
                    border: '1px solid var(--dsw-alias-border-l2, #ccc))',
                    boxShadow: '0 12px 48px rgba(0,0,0,0.45)',
                  },
                },
                h('div', { style: { fontSize: '14px', fontWeight: 600, marginBottom: '6px' } }, '开一个新会话讨论这条记录'),
                h('div', { style: { ...panelStyles.meta, marginBottom: '12px' } }, '会立刻发起一次带图的模型调用（约几秒）。'),
                h('div', { style: { ...panelStyles.meta, marginBottom: '6px' } }, '工作区'),
                h(
                  'div',
                  { style: { marginBottom: '14px' } },
                  h(
                    'select',
                    {
                      style: {
                        width: '100%',
                        padding: '7px 9px',
                        borderRadius: '8px',
                        border: '1px solid var(--dsw-alias-border-l2, #c4c8cf)',
                        background: 'transparent',
                        color: 'inherit',
                        fontSize: '12.5px',
                      },
                      value: workspaceId,
                      onChange: (event) => setWorkspaceId(event.target.value),
                      disabled: busy || workspaces.length === 0,
                    },
                    (workspaces.length > 0 ? workspaces : [{ id: '', title: '默认工作区', path: '' }]).map((item) =>
                      h('option', { key: item.id || 'default', value: item.id }, item.title || item.path || item.id),
                    ),
                  ),
                ),
                h('div', { style: { ...panelStyles.meta, marginBottom: '6px' } }, '模式'),
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                  (presets.length > 0 ? presets : [{ id: '', name: '默认' }]).map((item) =>
                    h(
                      'label',
                      {
                        key: item.id || 'default',
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          padding: '7px 10px',
                          borderRadius: '8px',
                          cursor: 'pointer',
                          border: `1px solid ${presetId === item.id ? '#4c8dff' : 'var(--dsw-alias-border-l1, #ddd))'}`,
                          background: presetId === item.id ? 'rgba(76,141,255,0.12)' : 'transparent',
                        },
                      },
                      h('input', {
                        type: 'radio',
                        name: 'spawn-preset',
                        checked: presetId === item.id,
                        onChange: () => {
                          setPresetId(item.id);
                          try {
                            window.localStorage.setItem('dsh-companion-journal.preset', item.id);
                          } catch {
                            /* 忽略 */
                          }
                        },
                      }),
                      h('span', null, item.name || item.id || '默认'),
                    ),
                  ),
                ),
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' } },
                  h('button', { style: panelStyles.chip(false), disabled: busy, onClick: () => setSpawnFor(null) }, '取消'),
                  h(
                    'button',
                    {
                      style: panelStyles.chip(true),
                      disabled: busy,
                      onClick: () => {
                        const record = spawnFor;
                        setSpawnFor(null);
                        void spawnSession(record);
                      },
                    },
                    busy ? '创建中…' : '创建',
                  ),
                ),
              ),
            )
          : null,
        sheetView
          ? h(
              'div',
              {
                style: {
                  position: 'fixed',
                  inset: 0,
                  background: 'rgba(0,0,0,0.78)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 9999,
                  cursor: 'zoom-out',
                },
                onClick: () => setSheetView(null),
              },
              h('img', {
                src: sheetView.url,
                alt: `拼图 ${sheetView.label}`,
                style: { maxWidth: '94vw', maxHeight: '92vh', borderRadius: '8px', boxShadow: '0 8px 40px rgba(0,0,0,0.5)' },
              }),
            )
          : null,
        zoom
          ? (() => {
              const count = imageCount(zoom);
              const index = clampIndex(zoom, zoom.thumbIndex);
              const move = (step) => {
                const next = index + step;
                if (next < 0 || next >= count) return;
                setZoom((current) => (current ? { ...current, thumbIndex: next } : current));
              };
              const arrow = (dir) =>
                h(
                  'button',
                  {
                    type: 'button',
                    'aria-label': dir < 0 ? '上一张' : '下一张',
                    title: dir < 0 ? '上一张（←）' : '下一张（→）',
                    style: panelStyles.zoomArrow(dir, dir < 0 ? index === 0 : index >= count - 1),
                    onClick: (event) => {
                      event.stopPropagation();
                      move(dir);
                    },
                  },
                  dir < 0 ? '‹' : '›',
                );
              return h(
                'div',
                {
                  style: {
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(0,0,0,0.72)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 9999,
                    cursor: 'zoom-out',
                  },
                  onClick: () => setZoom(null),
                },
                count > 1 ? arrow(-1) : null,
                h('img', {
                  // 必须带 index：多画面记录的原图按 images[index] 取，
                  // 不带的话永远显示第一张（点了第三张却看到第一张）。
                  src: `/dsh-companion-journal-8201/history/image/${encodeURIComponent(zoom.id)}?index=${index}`,
                  alt: `第 ${index + 1} 张`,
                  style: { maxWidth: '92vw', maxHeight: '90vh', borderRadius: '8px', boxShadow: '0 8px 40px rgba(0,0,0,0.5)' },
                }),
                count > 1 ? arrow(1) : null,
                count > 1 ? h('div', { style: panelStyles.zoomCounter }, `${index + 1} / ${count}`) : null,
              );
            })()
          : null,
        h(
          'div',
          { style: panelStyles.danger },
          h(
            'div',
            { style: { marginBottom: '8px', opacity: 0.8 } },
            `清理范围：${localDate(rangeOf(range).from) || '最早'} → ${localDate(rangeOf(range).to) || '今天'}`,
          ),
          h(
            'button',
            { style: { ...panelStyles.chip(false), marginRight: '8px' }, disabled: busy, onClick: () => void cleanup('images') },
            '只清理截图',
          ),
          h('button', { style: panelStyles.chip(false), disabled: busy, onClick: () => void cleanup('all') }, '删除全部记录'),
        ),
        ),
      );
    }

    /**
     * 设置页：DSH 设置里的「陪伴桌宠」一页。
     *
     * 为什么要有它：换立绘、开关桌宠这类事不该让用户去改 YAML 或翻文件路径。
     * 只暴露两件事——开/关、立绘路径；保存后插件会重建立绘进程，立即可见。
     */
    /** 把键盘事件翻译成宿主认识的组合串：`option+shift+L` / `F8`。 */
    function acceleratorOf(event) {
      const parts = [];
      if (event.metaKey) parts.push('command');
      if (event.altKey) parts.push('option');
      if (event.ctrlKey) parts.push('control');
      if (event.shiftKey) parts.push('shift');

      const key = String(event.key ?? '');
      let name = '';
      if (/^F([1-9]|1[0-2])$/.test(key)) name = key.toUpperCase();
      else if (/^[a-zA-Z]$/.test(key)) name = key.toUpperCase();
      else if (/^[0-9]$/.test(key)) name = key;
      else if (key === ' ') name = 'Space';
      else if (key === 'Enter') name = 'Return';
      else if (key === 'Tab') name = 'Tab';
      else return null; // 其它键不支持，忽略

      parts.push(name);
      return parts.join('+');
    }

    /** 组合串 → 给人看的符号：`option+shift+L` → `⌥⇧L`。 */
    function prettifyAccelerator(spec) {
      const map = { command: '⌘', option: '⌥', control: '⌃', shift: '⇧' };
      return String(spec ?? '')
        .split('+')
        .map((part) => map[part.toLowerCase()] ?? part)
        .join('');
    }

    /**
     * 快捷键录制框：点一下进入录制，按下组合键即写入。
     *
     * 为什么不让用户手打：`option+shift+L` 这种写法既难记又容易拼错，
     * 拼错了只知道「注册失败」，很难自查。按下即录最直观。
     */
    function HotkeyField({ label, value, onChange }) {
      const [recording, setRecording] = React.useState(false);
      // 排查用：显示最近一次收到的键。没有它，只能靠猜「事件没进来」还是「解析失败」。
      const [lastKey, setLastKey] = React.useState('');
      const inputRef = React.useRef(null);

      React.useEffect(() => {
        if (!recording) return;
        try {
          inputRef.current?.focus();
          inputRef.current?.select?.();
        } catch {
          /* 忽略 */
        }
      }, [recording]);

      const handleKey = (event) => {
        if (!recording) return;
        event.preventDefault();
        event.stopPropagation();
        setLastKey(event.key);
        if (event.key === 'Escape') {
          setRecording(false);
          setLastKey('');
          return;
        }
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
        const next = acceleratorOf(event);
        if (!next) {
          setLastKey(`${event.key}（不支持）`);
          return;
        }
        onChange(next);
        setRecording(false);
        setLastKey('');
      };

      // 输入框自身失焦即退出录制；但不要在这里读键盘——交给 onKeyDown 与全局兜底。
      React.useEffect(() => {
        if (!recording) return;
        const handler = (event) => handleKey(event);
        window.addEventListener('keydown', handler, true);
        return () => window.removeEventListener('keydown', handler, true);
      });

      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' } },
        h('span', { style: { opacity: 0.75 } }, label),
        h('input', {
          ref: inputRef,
          type: 'text',
          readOnly: true,
          value: recording ? (lastKey ? `按下… 收到：${lastKey}` : '按下组合键…') : prettifyAccelerator(value),
          placeholder: '点击后按组合键',
          onFocus: () => setRecording(true),
          onBlur: () => setRecording(false),
          onKeyDown: handleKey,
          onClick: () => setRecording(true),
          style: {
            minWidth: '150px',
            padding: '7px 12px',
            borderRadius: '8px',
            border: `1px solid ${recording ? 'var(--dsw-alias-brand-primary, #4c8dff)' : 'var(--dsw-alias-border-l2, #c4c8cf)'}`,
            background: recording ? 'rgba(76,141,255,0.10)' : 'transparent',
            color: 'inherit',
            fontSize: '13px',
            cursor: 'pointer',
            textAlign: 'left',
          },
        }),
        h('span', { style: { fontSize: '10.5px', opacity: 0.55 } }, '点击后按下组合键；Esc 取消'),
      );
    }

    function SettingsPage() {
      const [loading, setLoading] = React.useState(true);
      const [visible, setVisible] = React.useState(true);
      const [asset, setAsset] = React.useState('');
      const [size, setSize] = React.useState('160');
      const [fontSize, setFontSize] = React.useState('13');
      const [hotkeyLook, setHotkeyLook] = React.useState('F8');
      const [hotkeyAsk, setHotkeyAsk] = React.useState('F7');
      const [hotkeyCollect, setHotkeyCollect] = React.useState('F9');
      const [persona, setPersona] = React.useState('');
      /** 提示词：规则段全文（含密度那句，不含人设）。保存的是「跟模板不同」时才落盘。 */
      const [promptText, setPromptText] = React.useState('');
      const [promptChat, setPromptChat] = React.useState('');
      const [promptDefaults, setPromptDefaults] = React.useState({ text: '', chat: '' });
      /** 三档密度的文案：下拉改写文本里「4. …」那一行。 */
      const [promptLengths, setPromptLengths] = React.useState({});
      const [promptPreview, setPromptPreview] = React.useState(null);
      const [status, setStatus] = React.useState(null);
      const [note, setNote] = React.useState('');
      const [version, setVersion] = React.useState(0);
      const [picking, setPicking] = React.useState(false);
      /** 目录浏览弹层；null 表示没打开。 */
      const [browser, setBrowser] = React.useState(null);
      /** 系统权限：null = 还没读到（不要显示成「未授权」）。 */
      const [permissions, setPermissions] = React.useState(null);
      const [permissionBusy, setPermissionBusy] = React.useState('');
      const [permissionNote, setPermissionNote] = React.useState('');

      const load = React.useCallback(async () => {
        setLoading(true);
        try {
          const response = await fetch('/dsh-companion-journal-8201/settings', { cache: 'no-store' });
          const payload = await response.json();
          setVisible(payload?.settings?.buddy?.visible !== false);
          setAsset(String(payload?.settings?.buddy?.asset ?? ''));
          setSize(String(payload?.settings?.buddy?.size ?? 160));
          setFontSize(String(payload?.settings?.buddy?.fontSize ?? 13));
          setHotkeyLook(String(payload?.settings?.buddy?.hotkeys?.look ?? 'F8'));
          setHotkeyAsk(String(payload?.settings?.buddy?.hotkeys?.ask ?? 'F7'));
          setHotkeyCollect(String(payload?.settings?.buddy?.hotkeys?.collect ?? 'F9'));
          setPersona(String(payload?.persona ?? ''));
          setPromptText(String(payload?.prompt?.text ?? ''));
          setPromptChat(String(payload?.prompt?.chat ?? ''));
          setPromptDefaults(payload?.prompt?.defaults ?? { text: '', chat: '' });
          setPromptLengths(payload?.prompt?.lengths ?? {});
          setPromptPreview(payload?.prompt?.preview ?? null);
          setStatus(payload?.status ?? null);
          setPermissions(payload?.permissions ?? null);
        } catch (error) {
          setNote(`读取设置失败：${String(error?.message ?? error)}`);
        } finally {
          setLoading(false);
        }
      }, []);

      React.useEffect(() => {
        void load();
      }, [load]);

      const save = React.useCallback(async () => {
        setNote('保存中…');
        try {
          const response = await fetch('/dsh-companion-journal-8201/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              persona,
              prompt: { text: promptText, chat: promptChat },
              buddy: {
                visible,
                asset,
                // 空输入回落到默认值；只有保存时才解析，输入过程中允许清空。
                size: Number(size) || 160,
                fontSize: Number(fontSize) || 13,
                hotkeys: { look: hotkeyLook, ask: hotkeyAsk, collect: hotkeyCollect },
              },
            }),
          });
          const payload = await response.json();
          if (payload.ok) {
            if (payload.prompt) {
              setPromptDefaults(payload.prompt.defaults ?? { text: '', chat: '' });
              setPromptPreview(payload.prompt.preview ?? null);
              setPromptText(String(payload.prompt.text ?? ''));
            }
            setNote(payload.running ? '已保存，桌宠在运行' : '已保存，桌宠当前未运行');
            setVersion((n) => n + 1);
            void load();
          } else {
            setNote(`保存失败：${payload.reason ?? ''}`);
          }
        } catch (error) {
          setNote(`保存失败：${String(error?.message ?? error)}`);
        }
      }, [
        visible,
        asset,
        size,
        fontSize,
        hotkeyLook,
        hotkeyAsk,
        hotkeyCollect,
        persona,
        promptText,
        promptChat,
        load,
      ]);

      const refreshPermissions = React.useCallback(async () => {
        try {
          const response = await fetch('/dsh-companion-journal-8201/permissions', { cache: 'no-store' });
          setPermissions(await response.json());
        } catch (error) {
          setPermissionNote(`读取权限状态失败：${String(error?.message ?? error)}`);
        }
      }, []);

      const requestPermission = React.useCallback(async (kind) => {
        setPermissionBusy(kind);
        setPermissionNote(
          kind === 'screen'
            ? '正在请求屏幕录制授权，请在系统弹窗里操作…'
            : '正在请求辅助功能授权，请在系统弹窗里操作…',
        );
        try {
          const response = await fetch('/dsh-companion-journal-8201/permissions/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind }),
          });
          const payload = await response.json();
          setPermissions(payload);
          if (payload?.ok) {
            const granted = kind === 'screen' ? payload.screenRecording : payload.accessibility;
            setPermissionNote(
              granted
                ? '系统已授权。请完全退出并重开 DeepSeek Harness 后生效。'
                : '已发出系统授权请求；如果没有看到弹窗，点「打开设置」手动勾选，授权后需要完全退出并重启。',
            );
          } else {
            setPermissionNote(`请求失败：${payload?.reason ?? '未知原因'}；可以点「打开设置」手动勾选。`);
          }
        } catch (error) {
          setPermissionNote(`请求失败：${String(error?.message ?? error)}；可以点「打开设置」手动勾选。`);
        } finally {
          setPermissionBusy('');
        }
      }, []);

      const openPermissionPane = React.useCallback(async (kind) => {
        try {
          const response = await fetch('/dsh-companion-journal-8201/permissions/open', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind }),
          });
          const payload = await response.json();
          setPermissionNote(payload?.ok ? '已打开系统设置的对应面板。' : `打开设置失败：${payload?.reason ?? '未知原因'}`);
        } catch (error) {
          setPermissionNote(`打开设置失败：${String(error?.message ?? error)}`);
        }
      }, []);

      const warnIfOpaque = (path) => {
        // JPEG 没有 alpha 通道，白底会变成一个白方块；这里只提示，不拦着用户。
        if (/\.jpe?g$/i.test(String(path ?? ''))) {
          setNote('提示：JPEG 没有透明通道，屏幕上会显示成方块；建议换成 PNG');
          return true;
        }
        return false;
      };

      const label = { fontSize: '12px', opacity: 0.7, marginBottom: '4px' };
      const box = {
        padding: '14px 16px',
        borderRadius: '10px',
        // 边框用 l2（更强的一档）：l1 在浅色主题下几乎看不见，卡片会显得没边。
        border: '1px solid var(--dsw-alias-border-l2, #c4c8cf)',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        marginBottom: '12px',
      };

      /** 设置页里的小按钮（「立即显示」这类不需要布局大改的次要动作）。 */
      const btn = {
        padding: '5px 12px',
        borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border-l2, #c4c8cf)',
        background: 'transparent',
        color: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
      };
      const area = {
        width: '100%',
        padding: '9px 11px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, #c4c8cf)',
        background: 'transparent',
        color: 'inherit',
        fontSize: '12.5px',
        lineHeight: '19px',
        resize: 'vertical',
        boxSizing: 'border-box',
        fontFamily: 'inherit',
      };
      /** 取文本里「4. …」那行的内容（没有就是空串）。 */
      const lengthRuleOf = (text) => /^4\.\s*(.*)$/m.exec(String(text ?? ''))?.[1]?.trim() ?? '';
      /** 当前对应哪一档：匹配不到就是「自定义」，没有第 4 行则是 none。 */
      const currentPreset = (() => {
        const line = lengthRuleOf(promptText);
        for (const [id, rule] of Object.entries(promptLengths ?? {})) {
          if (String(rule ?? '').trim() === line) return id;
        }
        return line === '' ? 'none' : 'custom';
      })();
      /** 切档位 = 改写第 4 行；没有这行就补一行。 */
      const applyPreset = (id) => {
        const rule = String(promptLengths?.[id] ?? '').trim();
        if (rule === '') return;
        const line = `4. ${rule}`;
        setPromptText((text) =>
          /^4\./m.test(text) ? text.replace(/^4\..*$/m, line) : `${String(text).trimEnd()}\n${line}`,
        );
      };
      const smallBtn = {
        padding: '3px 10px',
        borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border-l2, #c4c8cf)',
        background: 'transparent',
        color: 'inherit',
        fontSize: '11.5px',
        cursor: 'pointer',
      };
      const promptField = (title, value, onChange, placeholder, rows = 5) =>
        h(
          'div',
          { style: { marginBottom: '10px' } },
          h('div', { style: label }, title),
          h('textarea', {
            value,
            placeholder,
            rows,
            onChange: (event) => onChange(event.target.value),
            style: area,
          }),
        );
      const permissionRow = (title, key, kind, hint) => {
        const granted = permissions?.[key];
        const state = key === 'automation' ? '按应用' : granted === true ? '已授权' : granted === false ? '未授权' : '未知';
        const color = granted === true ? '#2e9e5b' : granted === false ? '#c0392b' : 'inherit';
        return h(
          'div',
          {
            key,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '7px 0',
              borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
            },
          },
          h('div', { style: { width: '72px', fontSize: '12.5px', flexShrink: 0 } }, title),
          h('div', { style: { flex: 1, minWidth: 0, fontSize: '11.5px', opacity: 0.62, lineHeight: '16px' } }, hint || ''),
          h('div', { style: { fontSize: '11.5px', color, flexShrink: 0 } }, state),
          kind === 'screen' || kind === 'accessibility'
            ? h(
                'button',
                {
                  type: 'button',
                  style: { ...smallBtn, opacity: permissionBusy === kind ? 0.6 : 1 },
                  disabled: permissionBusy !== '',
                  onClick: () => void requestPermission(kind),
                },
                permissionBusy === kind ? '等待系统弹窗…' : '请求授权',
              )
            : null,
          h(
            'button',
            { type: 'button', style: smallBtn, onClick: () => void openPermissionPane(kind) },
            '打开设置',
          ),
        );
      };

      return h(
        'div',
        { style: { padding: '4px 0 24px', maxWidth: '640px' } },
        h('div', { style: { fontSize: '16px', fontWeight: 600, marginBottom: '4px' } }, '陪伴桌宠'),
        h(
          'div',
          { style: { fontSize: '12px', opacity: 0.65, marginBottom: '16px' } },
          '看一眼、对话式追问与陪伴记录都由这个插件提供；这里只调桌宠本身的显示。',
        ),

        h(
          'div',
          { style: box },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' } },
            h('div', { style: { fontSize: '13px', fontWeight: 600 } }, '权限'),
            h(
              'button',
              { type: 'button', style: smallBtn, onClick: () => void refreshPermissions() },
              '刷新状态',
            ),
          ),
          h(
            'div',
            { style: { fontSize: '11.5px', opacity: 0.65, lineHeight: '18px', marginBottom: '2px' } },
            '截图和窗口标题需要「屏幕录制」，读选中文字需要「辅助功能」。点「请求授权」会弹系统框；授权后必须完全退出并重开 DeepSeek Harness。',
          ),
          permissionRow('屏幕录制', 'screenRecording', 'screen', '截图 / 窗口标题 / 看一阵'),
          permissionRow('辅助功能', 'accessibility', 'accessibility', '读取选中文字与焦点元素'),
          permissionRow('自动化', 'automation', 'automation', '按应用授权；首次读取 Word / Preview / Skim 时系统会弹窗'),
          permissionNote
            ? h('div', { style: { fontSize: '11.5px', opacity: 0.75, marginTop: '6px', lineHeight: '17px' } }, permissionNote)
            : null,
        ),

        h(
          'div',
          { style: box },
          h('div', { style: label }, '人设'),
          h('textarea', {
            value: persona,
            onChange: (event) => setPersona(event.target.value),
            placeholder:
              '一段话说明它是谁、怎么称呼你、说话什么风格、有什么禁忌。留空 = 中性语气。\n例如：你是一只话不多的桌面搭子，叫我「老周」，说话别绕弯子，看到问题直接说，不要夸我。',
            rows: 6,
            style: area,
          }),
          h(
            'div',
            { style: { fontSize: '11px', opacity: 0.6, marginTop: '6px' } },
            '只影响语气、称呼与关注点；与提示词里的规则冲突时以规则为准。存放在 ~/.dsh/dsh-companion-journal/persona.md，也可以直接用编辑器改。',
          ),
        ),

        h(
          'div',
          { style: box },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' } },
            h('div', { style: { fontSize: '13px', fontWeight: 600 } }, '提示词'),
            h(
              'button',
              { type: 'button', style: smallBtn, onClick: () => setPromptText(String(promptDefaults.text ?? '')) },
              '重置为标准模板',
            ),
          ),
          h(
            'div',
            { style: { fontSize: '11px', opacity: 0.6, margin: '4px 0 10px' } },
            '「看一眼」发给模型的规则就是下面这段文字——你能看到、也能改。人设单独拼在它前面（规则放末尾，模型更容易遵守）。改完点底部「保存」，下一次触发时生效。',
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 8px', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: '12px', opacity: 0.75 } }, '信息密度'),
            h(
              'select',
              {
                value: currentPreset,
                onChange: (event) => applyPreset(event.target.value),
                style: {
                  padding: '5px 9px',
                  borderRadius: '8px',
                  border: '1px solid var(--dsw-alias-border-l2, #c4c8cf)',
                  background: 'transparent',
                  color: 'inherit',
                  fontSize: '12.5px',
                },
              },
              ...(currentPreset === 'custom' || currentPreset === 'none'
                ? [h('option', { key: 'custom', value: currentPreset }, currentPreset === 'none' ? '（未设置）' : '自定义（直接改文本）')]
                : []),
              ...[
                ['short', '简短：一句'],
                ['normal', '标准：两三句'],
                ['detailed', '详细：四到六句'],
              ].map(([value, text]) => h('option', { key: value, value }, text)),
            ),
            h('span', { style: { fontSize: '11px', opacity: 0.55 } }, '切换会替换下面第 4 行，其余文字不动'),
          ),
          h('textarea', {
            value: promptText,
            onChange: (event) => setPromptText(event.target.value),
            rows: 9,
            style: area,
          }),
          h(
            'div',
            { style: { fontSize: '11px', opacity: 0.55, marginTop: '6px' } },
            '提醒：删掉「不要 markdown」这类规则，输出里就会真的出现 **粗体** 和分点——那是故障，不是风格。',
          ),
          h('div', { style: { ...label, marginTop: '14px' } }, '追问规则（记录里的「接着问」）'),
          h('textarea', {
            value: promptChat,
            onChange: (event) => setPromptChat(event.target.value),
            rows: 6,
            style: area,
          }),
          promptPreview
            ? h(
                'details',
                { style: { marginTop: '12px' } },
                h('summary', { style: { fontSize: '12px', cursor: 'pointer', opacity: 0.8 } }, '查看拼好的完整系统提示词（含人设）'),
                h(
                  'pre',
                  {
                    style: {
                      marginTop: '8px',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      border: '1px solid var(--dsw-alias-border-l1, #ddd)',
                      fontSize: '11.5px',
                      lineHeight: '17px',
                      whiteSpace: 'pre-wrap',
                      maxHeight: '320px',
                      overflow: 'auto',
                      opacity: 0.92,
                    },
                  },
                  `【看一眼】\n${promptPreview.look ?? ''}\n\n【追问】\n${promptPreview.chat ?? ''}`,
                ),
              )
            : null,
          h(
            'div',
            { style: { fontSize: '11px', opacity: 0.55, marginTop: '10px' } },
            '存在 ~/.dsh/dsh-companion-journal/prompt.json：跟标准模板一致时不会写文件，所以以后改默认模板你能自动跟上。',
          ),
        ),

        h(
          'div',
          { style: box },
          h('div', { style: label }, '显示桌宠'),
          h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: visible,
              onChange: async (event) => {
                const next = event.target.checked;
                setVisible(next);
                // 立即生效：这一项是运行时状态，不该等「保存」才动。
                try {
                  await fetch(`/dsh-companion-journal-8201/buddy/${next ? 'show' : 'hide'}`, { method: 'POST' });
                  setNote(next ? '桌宠已显示' : '桌宠已隐藏（热键与陪伴记录照常可用）');
                } catch {
                  setNote('切换失败：宿主没有响应');
                }
              },
            }),
            '在屏幕上显示桌宠（勾选/取消都立即生效；隐藏后热键与陪伴记录照常可用）',
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px', flexWrap: 'wrap' } },
            h(
              'button',
              {
                type: 'button',
                style: btn,
                onClick: async () => {
                  try {
                    await fetch('/dsh-companion-journal-8201/buddy/show', { method: 'POST' });
                    setVisible(true);
                    setNote('已让桌宠重新显示');
                  } catch {
                    /* 宿主没起来：忽略 */
                  }
                },
              },
              '立即显示',
            ),
            h(
              'button',
              {
                type: 'button',
                style: btn,
                title: '把桌宠移回主屏右下角（拖丢时用这个找回）',
                onClick: () => {
                  void (async () => {
                    try {
                      const response = await fetch('/dsh-companion-journal-8201/buddy/recenter', { method: 'POST' });
                      const payload = await response.json();
                      setNote(payload.ok ? '已让桌宠回到主屏右下角' : `重置失败：${payload.reason ?? ''}`);
                    } catch (error) {
                      setNote(`重置失败：${String(error?.message ?? error)}`);
                    }
                  })();
                },
              },
              '重置人物位置',
            ),
            h(
              'span',
              { style: { fontSize: '11px', opacity: 0.6 } },
              '右键菜单里点了「隐藏」也可以从这里找回来',
            ),
          ),
        ),

        h(
          'div',
          { style: box },
          h('div', { style: label }, '快捷键'),
          h(
            'div',
            { style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } },
            h(HotkeyField, { label: '看一眼', value: hotkeyLook, onChange: setHotkeyLook }),
            h(HotkeyField, { label: '看一眼并提问（也可双击桌宠）', value: hotkeyAsk, onChange: setHotkeyAsk }),
            h(HotkeyField, { label: '多画面收集（开/关）', value: hotkeyCollect, onChange: setHotkeyCollect }),
          ),
          h(
            'div',
            { style: { fontSize: '11px', opacity: 0.6, marginTop: '6px' } },
            '点一下方框，然后按下想要的组合键（Esc 取消）。保存后立即重新注册，不需要重启 DSH。',
          ),
        ),

        h(
          'div',
          { style: box },
          h('div', { style: label }, '立绘 PNG 路径'),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'stretch' } },
            h('input', {
            type: 'text',
            value: asset,
            placeholder: '留空使用插件自带立绘，例如 ~/Pictures/buddy.png',
            onChange: (event) => setAsset(event.target.value),
            style: {
              width: '100%',
              padding: '7px 10px',
              borderRadius: '8px',
              border: '1px solid var(--dsw-alias-border-l2, #c4c8cf)',
              background: 'transparent',
              color: 'inherit',
              fontSize: '13px',
              boxSizing: 'border-box',
              flex: '1 1 auto',
            },
          }),
            h(
              'button',
              {
                style: {
                  flex: '0 0 auto',
                  padding: '0 14px',
                  borderRadius: '8px',
                  border: '1px solid var(--dsw-alias-border-l2, #c4c8cf)',
                  background: 'transparent',
                  color: 'inherit',
                  fontSize: '12px',
                  cursor: 'pointer',
                },
                onClick: () => {
                  // 原生面板：等用户选完才返回，所以按钮显示「选择中…」。
                  setPicking(true);
                  setNote('在弹出的窗口里选一张图…');
                  void (async () => {
                    try {
                      const response = await fetch('/dsh-companion-journal-8201/buddy/pick', { cache: 'no-store' });
                      const payload = await response.json();
                      if (!payload.ok) {
                        setNote(`选择失败：${payload.reason ?? ''}（可以试试「浏览…」）`);
                        return;
                      }
                      if (payload.cancelled) {
                        setNote('已取消选择');
                        return;
                      }
                      const picked = String(payload.path ?? '');
                      setAsset(picked);
                      if (!warnIfOpaque(picked)) setNote('已选好文件，点保存生效');
                    } catch (error) {
                      setNote(`选择失败：${String(error?.message ?? error)}（可以试试「浏览…」）`);
                    } finally {
                      setPicking(false);
                    }
                  })();
                },
              },
              picking ? '选择中…' : '选择…',
            ),
            h(
              'button',
              {
                style: {
                  flex: '0 0 auto',
                  padding: '0 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--dsw-alias-border-l2, #c4c8cf)',
                  background: 'transparent',
                  color: 'inherit',
                  fontSize: '12px',
                  cursor: 'pointer',
                },
                title: '不弹系统面板，直接在页面里翻目录',
                onClick: () => {
                  setNote('');
                  void (async () => {
                    try {
                      const response = await fetch('/dsh-companion-journal-8201/buddy/browse', { cache: 'no-store' });
                      const payload = await response.json();
                      if (!payload.ok) {
                        setNote(`打开目录失败：${payload.reason ?? ''}`);
                        return;
                      }
                      setBrowser({ dir: payload.dir, parent: payload.parent, entries: payload.entries ?? [] });
                    } catch (error) {
                      setNote(`打开目录失败：${String(error?.message ?? error)}`);
                    }
                  })();
                },
              },
              '浏览…',
            ),
          ),
          h(
            'div',
            { style: { fontSize: '11px', opacity: 0.6, marginTop: '6px' } },
            '要求：PNG、透明背景、建议 256×256。改完点保存，浮窗会立刻换图。',
          ),
          h(
            'div',
            { style: { marginTop: '12px', display: 'flex', alignItems: 'flex-end', gap: '12px' } },
            h('img', {
              src: `/dsh-companion-journal-8201/buddy/asset?v=${version}`,
              alt: '当前立绘',
              style: {
                width: '96px',
                height: '96px',
                objectFit: 'contain',
                imageRendering: 'pixelated',
                borderRadius: '8px',
                background: 'rgba(127,127,127,0.08)',
                border: '1px solid var(--dsw-alias-border-l2, #c4c8cf)',
              },
            }),
            h('div', { style: { fontSize: '11px', opacity: 0.6 } }, '当前生效的立绘预览'),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' } },
              h('span', { style: { fontSize: '11px', opacity: 0.7 } }, '尺寸'),
              h('input', {
                type: 'number',
                min: 64,
                max: 512,
                step: 8,
                value: size,
                onChange: (event) => setSize(event.target.value),
                style: {
                  width: '72px',
                  padding: '4px 8px',
                  borderRadius: '6px',
                  border: '1px solid var(--dsw-alias-border-l2, #c4c8cf)',
                  background: 'transparent',
                  color: 'inherit',
                  fontSize: '12px',
                },
              }),
              h('span', { style: { fontSize: '11px', opacity: 0.6 } }, 'pt'),
              h('span', { style: { fontSize: '11px', opacity: 0.7, marginLeft: '10px' } }, '字号'),
              h('input', {
                type: 'number',
                min: 10,
                max: 24,
                step: 1,
                value: fontSize,
                onChange: (event) => setFontSize(event.target.value),
                style: {
                  width: '60px',
                  padding: '4px 8px',
                  borderRadius: '6px',
                  border: '1px solid var(--dsw-alias-border-l2, #c4c8cf)',
                  background: 'transparent',
                  color: 'inherit',
                  fontSize: '12px',
                },
              }),
              h('span', { style: { fontSize: '11px', opacity: 0.6 } }, 'pt'),
            ),
          ),
        ),

        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h(
            'button',
            {
              onClick: () => void save(),
              disabled: loading,
              style: {
                padding: '7px 16px',
                borderRadius: '8px',
                border: '1px solid transparent',
                background: 'var(--dsw-alias-brand-primary, #4c8dff)',
                color: '#fff',
                fontSize: '13px',
                cursor: 'pointer',
              },
            },
            loading ? '读取中…' : '保存',
          ),
          h('span', { style: { fontSize: '12px', opacity: 0.75 } }, note),
        ),

        status
          ? h(
              'div',
              { style: { fontSize: '12px', opacity: 0.6, marginTop: '14px', lineHeight: '20px' } },
              h('div', null, `浮窗进程：${status.running ? '运行中' : '未运行'}`),
              h('div', null, `热键：${status.hotkey || '未注册'}`),
              h('div', { style: { wordBreak: 'break-all' } }, `当前立绘文件：${status.assetPath || '—'}`),
            )
          : null,

        browser
          ? h(
              'div',
              {
                style: {
                  position: 'fixed',
                  inset: 0,
                  background: 'rgba(0,0,0,0.45)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 9999,
                },
                onClick: () => setBrowser(null),
              },
              h(
                'div',
                {
                  onClick: (event) => event.stopPropagation(),
                  style: {
                    width: '560px',
                    maxWidth: '92vw',
                    maxHeight: '70vh',
                    display: 'flex',
                    flexDirection: 'column',
                    borderRadius: '12px',
                    border: '1px solid var(--dsw-alias-border-l2, #c4c8cf)',
                    background: 'var(--dsw-alias-bg-overlay, #fff)',
                    color: 'inherit',
                    boxShadow: '0 12px 48px rgba(0,0,0,0.3)',
                    overflow: 'hidden',
                  },
                },
                h(
                  'div',
                  {
                    style: {
                      padding: '10px 14px',
                      fontSize: '12px',
                      borderBottom: '1px solid var(--dsw-alias-border-l2, #c4c8cf)',
                      display: 'flex',
                      gap: '8px',
                      alignItems: 'center',
                    },
                  },
                  h(
                    'button',
                    {
                      style: { ...panelStyles.chip(false), fontSize: '11px' },
                      onClick: () => {
                        if (!browser?.parent) return;
                        void (async () => {
                          const response = await fetch(`/dsh-companion-journal-8201/buddy/browse?dir=${encodeURIComponent(browser.parent)}`, { cache: 'no-store' });
                          const payload = await response.json();
                          if (payload.ok) setBrowser({ dir: payload.dir, parent: payload.parent, entries: payload.entries ?? [] });
                        })();
                      },
                    },
                    '上一级',
                  ),
                  h('span', { style: { opacity: 0.7, wordBreak: 'break-all' } }, browser?.dir ?? ''),
                ),
                h(
                  'div',
                  { style: { overflow: 'auto', padding: '6px 0' } },
                  (browser?.entries ?? []).length === 0
                    ? h('div', { style: { padding: '12px 14px', fontSize: '12px', opacity: 0.6 } }, '这个目录里没有子目录或图片')
                    : (browser?.entries ?? []).map((entry) =>
                        h(
                          'div',
                          {
                            key: entry.path,
                            onClick: () => {
                              if (entry.dir) {
                                void (async () => {
                                  const response = await fetch(`/dsh-companion-journal-8201/buddy/browse?dir=${encodeURIComponent(entry.path)}`, { cache: 'no-store' });
                                  const payload = await response.json();
                                  if (payload.ok) setBrowser({ dir: payload.dir, parent: payload.parent, entries: payload.entries ?? [] });
                                  else setNote(`打开目录失败：${payload.reason ?? ''}`);
                                })();
                              } else {
                                setAsset(entry.path);
                                setBrowser(null);
                                if (!warnIfOpaque(entry.path)) setNote('已选好文件，点保存生效');
                              }
                            },
                            style: {
                              padding: '7px 14px',
                              fontSize: '12.5px',
                              cursor: 'pointer',
                              display: 'flex',
                              gap: '8px',
                              alignItems: 'center',
                            },
                          },
                          h('span', { style: { opacity: 0.6 } }, entry.dir ? '📁' : '🖼'),
                          h('span', { style: { wordBreak: 'break-all' } }, entry.name),
                        ),
                      ),
                ),
              ),
            )
          : null,
      );
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        // 只上报一次：宿主据此判断是否需要提醒「重启客户端」。
        void fetch('/dsh-companion-journal-8201/client-version', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: CLIENT_VERSION }),
        }).catch(() => {});
        // 点气泡 / 右键菜单的「陪伴记录」后，宿主通过 SSE 推过来：先把主区切到
        // 「陪伴记录」，再让面板定位。
        //
        // 这里刻意把连接做成**页面级单例**（挂在 window 上），而不是 apply 里新建、卸载时关闭：
        // 插件每重挂一次就会新建/关闭一条连接，而页面的 apply 不会因为宿主重挂而重跑——
        // 表现就是「菜单点了没反应」，而且旧连接的回调还指着已经废弃的 ctx（用户实测报过两次）。
        //
        // 现在：页面里只保留一条 EventSource；每次 apply 只把「打开面板」的能力换成新实例的函数，
        // 消息本身永远交给 window 上的最新实现。
        const openHistoryPanel = (src = 'unknown') => {
          // 上报来源：排查「面板自己弹出来」时，能区分是 SSE 推送还是兜底查询。
          void fetch('/dsh-companion-journal-8201/panel-open', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ src }),
          }).catch(() => {});
          try {
            ctx.layout.selectPanel('dsh-companion-journal-history');
          } catch {
            /* 面板还没注册：下面仍会广播，用户手动打开时能定位 */
          }
        };
        const focusRecord = (recordId) => {
          try {
            window.dispatchEvent(new CustomEvent('dsh-companion-journal:focus-record', { detail: String(recordId ?? '') }));
          } catch {
            /* 忽略 */
          }
        };
        const consumePending = () => {
          void fetch('/dsh-companion-journal-8201/buddy/consume', { method: 'POST' }).catch(() => {});
        };
        /** 窗口获得焦点时补一次：宿主有 pending 就切面板（event-driven，无定时器）。 */
        const refreshPending = async () => {
          try {
            const response = await fetch('/dsh-companion-journal-8201/buddy/pending', { cache: 'no-store' });
            if (!response.ok) return;
            const payload = await response.json();
            if (payload?.panel !== true) return;
            window.__dshCompanionPanel?.openHistoryPanel('pending');
            window.__dshCompanionPanel?.focusRecord(payload?.recordId ?? '');
            window.__dshCompanionPanel?.consumePending();
          } catch {
            /* 宿主没起来或路由没挂：忽略，下次焦点再试 */
          }
        };
        window.__dshCompanionPanel = { openHistoryPanel, focusRecord, consumePending, refreshPending };

        const existing = window.__dshCompanionSSE;
        if (!existing || existing.readyState === 2) {
          try {
            const source = new EventSource('/dsh-companion-journal-8201/buddy/events');
            window.__dshCompanionSSE = source;
            source.onmessage = (event) => {
              let payload = null;
              try {
                payload = JSON.parse(event.data);
              } catch {
                return;
              }
              const panel = window.__dshCompanionPanel;
              panel?.openHistoryPanel('sse');
              panel?.focusRecord(payload?.recordId ?? '');
              // 取走即清空：否则窗口下次获得焦点时会再切一次面板。
              panel?.consumePending();
            };
            source.onerror = () => {
              // 彻底关闭时释放引用，下次 apply 会重建；CONNECTING 状态交给浏览器自己重连。
              if (source.readyState === 2) window.__dshCompanionSSE = null;
            };
            // 注意：**不**在 ctx.effect 里关闭它。页面级共享连接必须活过插件重挂。
          } catch {
            /* 不支持 EventSource：focus 兜底仍然是通的 */
          }
        }

        // 三条事件都去查一次 pending（都是事件驱动，没有定时器）：
        //   - focus：从别的应用切回 DSH；
        //   - pointerdown：DSH 已经是前台时（点桌宠菜单常见），第一次点页面就补上；
        //   - visibilitychange：页面从后台恢复。
        let lastCheck = 0;
        const checkPending = () => {
          const now = Date.now();
          // 同一毫秒内的连点不用查多次；3 秒节流足够，且不会让人等。
          if (now - lastCheck < 3000) return;
          lastCheck = now;
          void window.__dshCompanionPanel?.refreshPending();
        };
        const onVisibility = () => {
          if (document.visibilityState === 'visible') checkPending();
        };
        window.addEventListener('focus', checkPending);
        window.addEventListener('pointerdown', checkPending, true);
        document.addEventListener('visibilitychange', onVisibility);
        ctx.effect(() => () => {
          window.removeEventListener('focus', checkPending);
          window.removeEventListener('pointerdown', checkPending, true);
          document.removeEventListener('visibilitychange', onVisibility);
        });


        // 与模板一致：inject 的回调本身就是注册载体，插槽折叠时会自动回收，
        // 不需要再包一层 ctx.effect（包了反而要求它返回 disposer）。
        // 侧边栏入口 + 主区面板：keyed 槽用同一个 key 关联。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'dsh-companion-journal-history', order: 60, label: '陪伴记录' },
            HistoryIcon,
          ),
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'dsh-companion-journal-history' }, HistoryPanel),
        );
        // 设置页：DSH 设置 → 陪伴桌宠。
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-companion-journal-settings', order: 80, label: '陪伴桌宠' },
            SettingsPage,
          ),
        );
      },
    };
  },
});

/**
 * titanium-fisheye — browser half: the settings page.
 *
 * The page exists to make one thing visible: whether the eye works, and what it
 * sees. It reports the real screen size the engine measures, lists the windows
 * that can be captured, and shows the most recent frame. The agent uses the tool
 * directly; nothing here is required for capture to work.
 */
window.__ModuleLoader__.load({
  id: 'titanium-fisheye',
  factory(require) {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    /** Locale namespace these strings register under. */
    const NS = 'settings.titaniumFisheye'
    /** Route prefix the Host half serves. */
    const ROUTE = (() => {
      try {
        return new URL('api/titanium-fisheye', document.baseURI).pathname
      } catch {
        return '/api/titanium-fisheye'
      }
    })()
    /** Poll cadence for the status document. */
    const POLL_MS = 4000

    const DICT = {
      zh: {
        'meta.title': '钛合金鱼眼',
        'meta.description': '给 agent 一双真正的眼睛：全屏、桌面、单个窗口都能精确截图，被遮挡也看得见。',
        nav: '钛合金鱼眼',
        'page.title': '钛合金鱼眼',
        'page.description': 'Titanium Fisheye —— agent 的截图工具。它先声明 DPI 感知再取像素，所以尺寸永远是物理像素，不会出现「看起来对、其实差 0.8 倍」的情况。',
        'section.eye': '眼睛',
        'screen.title': '真实屏幕',
        'screen.hint': '由 Windows API 读出，与截图尺寸一致。',
        'section.targets': '三种截图',
        'target.screen': '全屏（screen）',
        'target.screenHint': '人眼所见：被窗口盖住的部分就是盖住的样子。',
        'target.desktop': '桌面（desktop）',
        'target.desktopHint': '壁纸和图标由桌面自己绘制，被窗口遮挡也能看见。',
        'target.window': '单窗口（window）',
        'target.windowHint': '窗口自己绘制，不需要置顶或聚焦就能截全。',
        'section.windows': '可截取的窗口',
        'windows.count': '{n} 个可见窗口，其中 {m} 个可截取',
        'windows.minimized': '已最小化，不可截',
        'windows.empty': '当前没有可见窗口。',
        'section.capture': '试一张',
        'capture.hint': '点按钮立刻截一张，用来确认眼睛是否正常。',
        'action.screen': '截全屏',
        'action.desktop': '截桌面',
        'section.recent': '最近截图',
        'recent.empty': '还没有截图。让 agent 用一次 eye 工具，或点上面的按钮。',
        'recent.openHint': '点击在资源管理器中定位这张图',
        'recent.remove': '删除这张',
        'action.clear': '清空',
        'page.offline': '连不上插件后端。',
        'page.ok': '正常',
      },
      en: {
        'meta.title': '钛合金鱼眼',
        'meta.description': 'A real eye for the agent: precise captures of the screen, the desktop, or one window — visible even when covered.',
        nav: '钛合金鱼眼',
        'page.title': '钛合金鱼眼',
        'page.description': 'Titanium Fisheye — the agent\'s screenshot tool. It declares DPI awareness before reading pixels, so sizes are always real physical pixels.',
        'section.eye': 'The eye',
        'screen.title': 'Real screen',
        'screen.hint': 'Read from the Windows API; matches what a capture reports.',
        'section.targets': 'Three captures',
        'target.screen': 'Screen',
        'target.screenHint': 'What a person sees: a covering window hides what is beneath it.',
        'target.desktop': 'Desktop',
        'target.desktopHint': 'The shell paints wallpaper and icons, so they show even where windows cover them.',
        'target.window': 'Window',
        'target.windowHint': 'The window paints itself, so it needs no raising or focusing.',
        'section.windows': 'Capturable windows',
        'windows.count': '{n} visible, {m} capturable',
        'windows.minimized': 'minimized, not capturable',
        'windows.empty': 'No visible windows right now.',
        'section.capture': 'Try one',
        'capture.hint': 'Capture immediately to check the eye works.',
        'action.screen': 'Capture screen',
        'action.desktop': 'Capture desktop',
        'section.recent': 'Recent captures',
        'recent.empty': 'Nothing yet. Ask the agent to use the eye tool, or use a button above.',
        'recent.openHint': 'Click to reveal this file in Explorer',
        'recent.remove': 'Delete this one',
        'action.clear': 'Clear',
        'page.offline': 'Plugin backend unreachable.',
        'page.ok': 'OK',
      },
    }

    /** Fallback translator when a section renders without the shell's own `t`. */
    let boundT = (key) => key

    const store = {
      status: 'loading',
      screen: null,
      windows: [],
      recent: [],
      error: '',
    }
    const listeners = new Set()

    function publish(patch) {
      Object.assign(store, patch)
      for (const listener of [...listeners]) {
        try { listener() } catch { /* one broken subscriber must not stop the rest */ }
      }
    }

    async function request(path, options) {
      const { timeout = 15000, ...rest } = options ?? {}
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const response = await fetch(`${ROUTE}${path}`, { redirect: 'error', ...rest, signal: controller.signal })
        const text = await response.text()
        const payload = text === '' ? {} : JSON.parse(text)
        if (!response.ok) throw new Error(String(payload?.error ?? `HTTP ${response.status}`))
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    async function refresh() {
      try {
        const state = await request('/state')
        publish({
          status: 'ready',
          screen: state?.screen ?? null,
          recent: Array.isArray(state?.recent) ? state.recent : [],
          error: '',
        })
        const list = await request('/capture', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'list' }),
          timeout: 20000,
        })
        publish({ windows: Array.isArray(list?.windows) ? list.windows : [] })
      } catch (error) {
        publish({ status: 'error', error: String(error?.message ?? error) })
      }
    }

    function Row(props) {
      return h('div', { className: 'tf_row' },
        h('div', { className: 'tf_rowText' },
          h('div', { className: 'tf_rowTitle' }, props.title),
          props.hint === undefined ? null : h('div', { className: 'tf_rowHint' }, props.hint)),
        props.control === undefined ? null : h('div', { className: 'tf_controls' }, props.control))
    }

    function SettingsPage(props) {
      const t = typeof props.t === 'function' ? props.t : boundT
      const [snapshot, setSnapshot] = useState({
        status: store.status,
        screen: store.screen,
        windows: store.windows,
        recent: store.recent,
        error: store.error,
      })

      useEffect(() => {
        const listener = () => setSnapshot({
          status: store.status,
          screen: store.screen,
          windows: store.windows,
          recent: store.recent,
          error: store.error,
        })
        listeners.add(listener)
        listener()
        return () => { listeners.delete(listener) }
      }, [])

      useEffect(() => {
        void refresh()
        const timer = setInterval(() => {
          if (document.visibilityState === 'hidden') return
          void refresh()
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [])

      const captureNow = useCallback(async (action) => {
        try {
          await request('/capture', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action }),
            timeout: 30000,
          })
        } catch (error) {
          publish({ status: 'error', error: String(error?.message ?? error) })
          return
        }
        await refresh()
      }, [])

      /** Delete every capture. */
      const clearAll = useCallback(async () => {
        try {
          await request('/recent/clear', { method: 'POST', timeout: 20000 })
        } catch (error) {
          publish({ status: 'error', error: String(error?.message ?? error) })
          return
        }
        await refresh()
      }, [])

      /** Delete one capture. */
      const removeOne = useCallback(async (id) => {
        try {
          await request(`/recent/${encodeURIComponent(id)}`, { method: 'DELETE', timeout: 15000 })
        } catch (error) {
          publish({ status: 'error', error: String(error?.message ?? error) })
          return
        }
        await refresh()
      }, [])

      /** Show the file in Explorer so it can be opened or moved. */
      const reveal = useCallback(async (id) => {
        try {
          await request('/reveal', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
            timeout: 15000,
          })
        } catch (error) {
          publish({ status: 'error', error: String(error?.message ?? error) })
        }
      }, [])

      const screen = snapshot.screen
      const visible = snapshot.windows.filter((w) => w.minimized !== true)
      const minimized = snapshot.windows.length - visible.length

      return h('div', { className: 'tf_root' },
        h('header', { className: 'tf_head' },
          h('h2', { className: 'tf_title' }, t('page.title')),
          h('p', { className: 'tf_desc' }, t('page.description'))),

        h('div', { className: 'tf_section' }, t('section.eye')),
        h(Row, {
          title: t('screen.title'),
          hint: screen === null ? t('page.offline') : t('screen.hint'),
          control: h('span', { className: 'tf_badge' },
            screen === null ? '—' : `${screen.w} × ${screen.h}`),
        }),

        h('div', { className: 'tf_section' }, t('section.targets')),
        h(Row, {
          title: t('target.screen'),
          hint: t('target.screenHint'),
          control: h('button', {
            type: 'button',
            className: 'tf_btn',
            onClick: () => void captureNow('screen'),
          }, t('action.screen')),
        }),
        h(Row, {
          title: t('target.desktop'),
          hint: t('target.desktopHint'),
          control: h('button', {
            type: 'button',
            className: 'tf_btn',
            onClick: () => void captureNow('desktop'),
          }, t('action.desktop')),
        }),
        h(Row, {
          title: t('target.window'),
          hint: t('target.windowHint'),
        }),

        h('div', { className: 'tf_section' }, t('section.windows')),
        h('div', { className: 'tf_note' },
          t('windows.count').replace('{n}', String(snapshot.windows.length)).replace('{m}', String(visible.length))),
        snapshot.windows.length === 0
          ? h('div', { className: 'tf_note' }, t('windows.empty'))
          : h('ul', { className: 'tf_list' },
            snapshot.windows.slice(0, 14).map((w) => h('li', {
              key: String(w.hwnd),
              className: w.minimized === true ? 'tf_item tf_item_off' : 'tf_item',
            },
            h('span', { className: 'tf_itemTitle' }, w.title),
            h('span', { className: 'tf_itemMeta' },
              `${w.w}×${w.h}${w.minimized === true ? ` · ${t('windows.minimized')}` : ''}`)))),
        minimized > 0 ? h('div', { className: 'tf_note' }, `· ${minimized} ${t('windows.minimized')}`) : null,

        h('div', { className: 'tf_sectionRow' },
          h('span', { className: 'tf_section' }, t('section.recent')),
          snapshot.recent.length === 0
            ? null
            : h('button', {
              type: 'button',
              className: 'tf_btn tf_btn_danger',
              onClick: () => void clearAll(),
            }, t('action.clear'))),
        snapshot.recent.length === 0
          ? h('div', { className: 'tf_note' }, t('recent.empty'))
          : h('div', { className: 'tf_shots' },
            snapshot.recent.slice(0, 12).map((shot) => h('figure', { key: shot.id, className: 'tf_shot' },
              h('div', { className: 'tf_shotFrame' },
                h('img', {
                  className: 'tf_shotImg',
                  src: `${ROUTE}/recent/${encodeURIComponent(shot.id)}`,
                  alt: `${shot.kind} ${shot.width}x${shot.height}`,
                  loading: 'lazy',
                  title: t('recent.openHint'),
                  onClick: () => void reveal(shot.id),
                }),
                h('button', {
                  type: 'button',
                  className: 'tf_shotClose',
                  title: t('recent.remove'),
                  'aria-label': t('recent.remove'),
                  onClick: (event) => {
                    // The image behind it opens Explorer, so the close button must
                    // not let the click through.
                    event.stopPropagation()
                    void removeOne(shot.id)
                  },
                }, '×')),
              h('figcaption', { className: 'tf_shotCap' },
                `${shot.kind} · ${shot.width}×${shot.height}`)))),

        snapshot.status === 'error'
          ? h('footer', { className: 'tf_footer tf_footer_err' }, `${t('page.offline')} ${snapshot.error}`)
          : h('footer', { className: 'tf_footer' }, t('page.ok')))
    }

    const CSS = `
.tf_root{display:flex;flex-direction:column;color:var(--dsw-alias-label-primary)}
.tf_head{padding:2px 0 14px}
.tf_title{margin:0 0 6px;font-size:16px;font-weight:600;line-height:24px;letter-spacing:-.1px}
.tf_desc{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.tf_section{padding:18px 0 6px;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}
.tf_row{display:flex;align-items:center;gap:24px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.tf_rowText{flex:1;min-width:0}
.tf_rowTitle{font-size:14px;font-weight:500;line-height:22px}
.tf_rowHint{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.tf_controls{display:flex;align-items:center;gap:10px;flex:none}
.tf_badge{font-size:13px;line-height:18px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);padding:4px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2)}
.tf_btn{font:inherit;font-size:12px;line-height:18px;padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
.tf_btn:hover{filter:brightness(1.06)}
.tf_note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:6px 0 0}
.tf_list{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.tf_item{display:flex;align-items:center;gap:12px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);font-size:13px}
.tf_item_off{opacity:.55}
.tf_itemTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tf_itemMeta{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.tf_shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-top:10px}
.tf_shot{margin:0;display:flex;flex-direction:column;gap:6px}
.tf_shotFrame{position:relative;display:block}
.tf_shotImg{width:100%;height:auto;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);display:block;cursor:pointer}
.tf_shotImg:hover{border-color:var(--dsw-alias-state-business-primary)}
.tf_shotClose{position:absolute;top:4px;right:4px;width:20px;height:20px;line-height:18px;padding:0;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:rgba(20,20,24,.82);color:#fff;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.tf_shotClose:hover{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.tf_shotCap{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.tf_sectionRow{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding-top:18px}
.tf_sectionRow .tf_section{padding:0}
.tf_btn_danger:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.tf_footer{padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.tf_footer_err{color:var(--dsw-alias-state-error-primary)}
`

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      boundT = t
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'titanium-fisheye: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'titanium-fisheye')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'titanium-fisheye: styles')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'titanium-fisheye',
        order: 50,
        label: () => t('nav'),
        locale: NS,
      }, (props) => h(SettingsPage, { ...props, t: typeof props?.t === 'function' ? props.t : t })))
    }

    return { inject: ['slots', 'locale'], apply }
  },
})

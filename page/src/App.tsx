import './App.css'
import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { Magnet, FilePlus2, Plus, X, Pencil, Check, ChevronDown, Search, CircleHelp } from 'lucide-react'
import { DeviceTree } from '@/components/DeviceTree'
import { LayoutManager } from '@/components/LayoutManager'
import { VisualGrid } from '@/components/VisualGrid'
import { useCanvasStore, getTemporalStore, beginCanvasHistoryBatch, endCanvasHistoryBatch } from '@/lib/canvasStore'
import { useBridgeStore } from '@/lib/bridge'
import type { LayoutInfo } from '@/lib/bridge'
import { cn } from '@/lib/utils'
import { t, useLocale } from '@/lib/i18n'

const LAYOUT_NAME_MAX_CHARS = 64

function contentWidth(value: string, placeholder: string) {
  return `${Math.max(value.length, placeholder.length, 2)}ch`
}

function parseGridSize(value: string): number | null {
  const text = value.trim()
  if (!text) return null
  const n = Number(text)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.max(1, Math.round(n))
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tagName = target.tagName
  return target.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT'
}

function GridSizeInput({ label, ariaLabel, value, onCommit, onEditStart, onEditEnd }: {
  label: string
  ariaLabel: string
  value: number
  onCommit: (v: number) => void
  onEditStart: () => void
  onEditEnd: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? String(value)

  return (
    <label className="h-[40px] shrink-0 px-[10px] rounded-[10px] border border-border bg-secondary inline-flex items-center gap-[8px]">
      <span className="text-[13px] text-muted-foreground">{label}:</span>
      <input
        className="h-full min-w-[2ch] bg-transparent border-none outline-none text-[13px] text-foreground placeholder:text-muted-foreground"
        value={text}
        onFocus={() => {
          onEditStart()
          setDraft(String(value))
        }}
        onChange={e => {
          const next = e.target.value
          setDraft(next)
          const parsed = parseGridSize(next)
          if (parsed != null) onCommit(parsed)
        }}
        onBlur={e => {
          const parsed = parseGridSize(e.currentTarget.value)
          const next = parsed ?? value
          onCommit(next)
          setDraft(null)
          onEditEnd()
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          }
        }}
        placeholder={t('gridSize.placeholder')}
        aria-label={ariaLabel}
        style={{ width: contentWidth(text, t('gridSize.placeholder')) }}
      />
    </label>
  )
}

/* ── Inline editable text (for layout name) ── */
function InlineEdit({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setText(value) }, [value])
  useEffect(() => { if (editing) inputRef.current?.select() }, [editing])

  const commit = () => {
    setEditing(false)
    const trimmed = text.trim()
    if (trimmed && trimmed !== value) onCommit(trimmed)
    else setText(value)
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        onClick={() => setEditing(true)}
        title={t('layout.rename')}
      >
        <Pencil className="size-3" />
      </button>
    )
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        ref={inputRef}
        className="h-[24px] w-[100px] px-1 rounded bg-secondary border border-border text-[12px] text-foreground outline-none"
        value={text}
        maxLength={LAYOUT_NAME_MAX_CHARS}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setEditing(false); setText(value) } }}
      />
      <button type="button" className="p-0.5 cursor-pointer" onClick={commit}><Check className="size-3" /></button>
    </span>
  )
}

/* ── Layout dropdown selector ── */
function LayoutSelector({ layouts, activeLayout, onSwitch, onCreate, onDelete }: {
  layouts: LayoutInfo[]
  activeLayout: LayoutInfo | null
  onSwitch: (id: string) => void
  onCreate: (name: string) => void
  onDelete: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Focus search when opened
  useEffect(() => {
    if (open) searchRef.current?.focus()
  }, [open])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return layouts
    return layouts.filter(l => l.name.toLowerCase().includes(q))
  }, [layouts, search])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className="h-[40px] px-[12px] rounded-[10px] border border-border bg-secondary hover:bg-accent cursor-pointer transition-colors flex items-center gap-[8px] text-[13px] font-medium"
        onClick={() => { setOpen(v => !v); setSearch('') }}
      >
        <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
        <span className={cn(
          'w-[6px] h-[6px] rounded-full shrink-0',
          activeLayout?.registered ? 'bg-green-500' : 'bg-muted-foreground/30',
        )} />
        <span className="truncate max-w-[160px]">{activeLayout?.name ?? t('layout.select')}</span>
      </button>

      {open && (
        <div className="absolute top-[calc(100%+6px)] left-0 z-50 w-[280px] rounded-[10px] border border-border bg-popover shadow-lg flex flex-col overflow-hidden animate-in fade-in-0 slide-in-from-top-2 duration-150">
          {/* Sticky header: new + search */}
          <div className="shrink-0 flex items-center gap-[6px] p-[8px] border-b border-border">
            <button
              type="button"
              className="h-[32px] px-[10px] rounded-[8px] border border-dashed border-border hover:bg-accent cursor-pointer transition-colors flex items-center gap-[4px] text-[12px] text-muted-foreground shrink-0"
              onClick={() => {
                onCreate(t('layout.defaultName').replace('{n}', String(layouts.length + 1)))
              }}
            >
              <Plus className="size-3.5" />
              {t('layout.create')}
            </button>
            <div className="flex-1 h-[32px] rounded-[8px] border border-border bg-secondary flex items-center gap-[6px] px-[8px]">
              <Search className="size-3.5 text-muted-foreground shrink-0" />
              <input
                ref={searchRef}
                className="flex-1 h-full bg-transparent border-none outline-none text-[12px] text-foreground placeholder:text-muted-foreground"
                placeholder={t('layout.search')}
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          </div>

          {/* Scrollable layout list */}
          <div className="overflow-y-auto max-h-[240px] py-[4px]">
            {filtered.length === 0 && (
              <div className="px-[12px] py-[8px] text-[12px] text-muted-foreground text-center">
                {t('layout.noMatch')}
              </div>
            )}
            {filtered.map(layout => (
              <div
                key={layout.id}
                className={cn(
                  'flex items-center gap-[6px] h-[36px] px-[12px] cursor-pointer transition-colors',
                  layout.id === activeLayout?.id
                    ? 'bg-accent font-medium'
                    : 'hover:bg-accent/50',
                )}
                onClick={() => {
                  onSwitch(layout.id)
                  setOpen(false)
                  setSearch('')
                }}
              >
                <span className={cn(
                  'w-[6px] h-[6px] rounded-full shrink-0',
                  layout.registered ? 'bg-green-500' : 'bg-muted-foreground/30',
                )} />
                <span className="flex-1 truncate text-[13px] text-foreground">
                  {layout.name}
                </span>
                {layouts.length > 1 && (
                  <button
                    type="button"
                    className="p-[2px] rounded hover:bg-destructive/15 transition-colors shrink-0 cursor-pointer"
                    onClick={e => {
                      e.stopPropagation()
                      onDelete(layout.id)
                    }}
                    title={t('layout.delete')}
                  >
                    <X className="size-3.5 text-destructive" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function App() {
  useLocale() // subscribe to locale changes for re-render
  const canvasBounds = useCanvasStore(s => s.canvasBounds)
  const updateCanvasBounds = useCanvasStore(s => s.updateCanvasBounds)
  const snapToGrid = useCanvasStore(s => s.snapToGrid)
  const toggleSnap = useCanvasStore(s => s.toggleSnapToGrid)
  const placedDevices = useCanvasStore(s => s.placedDevices)
  const canvasLayoutId = useCanvasStore(s => s.layoutId)
  const hydrateFromLayout = useCanvasStore(s => s.hydrateFromLayout)

  const layouts = useBridgeStore(s => s.layouts)
  const activeLayoutId = useBridgeStore(s => s.activeLayoutId)
  const switchLayout = useBridgeStore(s => s.switchLayout)
  const createLayout = useBridgeStore(s => s.createLayout)
  const deleteLayout = useBridgeStore(s => s.deleteLayout)
  const renameLayout = useBridgeStore(s => s.renameLayout)
  const registerCanvas = useBridgeStore(s => s.registerCanvas)
  const unregisterCanvas = useBridgeStore(s => s.unregisterCanvas)
  const syncPlacements = useBridgeStore(s => s.syncPlacements)
  const updateSnap = useBridgeStore(s => s.updateSnap)

  const activeLayout = layouts.find(l => l.id === activeLayoutId) ?? null
  const canvasRegistered = activeLayout?.registered ?? false
  const canvasWidth = Math.max(1, Math.round(canvasBounds.width))
  const canvasHeight = Math.max(1, Math.round(canvasBounds.height))

  // Hydrate canvas store when active layout changes or layouts arrive from backend
  const hydratedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeLayout) return
    if (hydratedRef.current === activeLayout.id && canvasLayoutId === activeLayout.id) return
    hydratedRef.current = activeLayout.id
    hydrateFromLayout(
      activeLayout.id,
      activeLayout.canvas,
      activeLayout.placements,
      activeLayout.snap_to_grid,
    )
  }, [activeLayout, canvasLayoutId, hydrateFromLayout])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return

      const isModifierPressed = event.ctrlKey || event.metaKey
      if (!isModifierPressed || event.altKey) return

      const key = event.key.toLowerCase()
      if (!event.shiftKey && key === 'z') {
        getTemporalStore().getState().undo()
        event.preventDefault()
        return
      }

      if ((event.shiftKey && key === 'z') || key === 'y') {
        getTemporalStore().getState().redo()
        event.preventDefault()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Debounced placement sync
  const syncTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    if (!activeLayoutId) return
    if (canvasLayoutId !== activeLayoutId) return
    clearTimeout(syncTimerRef.current)
    syncTimerRef.current = setTimeout(() => {
      syncPlacements(activeLayoutId, placedDevices, canvasBounds)
    }, 200)
    return () => clearTimeout(syncTimerRef.current)
  }, [placedDevices, canvasBounds, activeLayoutId, canvasLayoutId, syncPlacements])

  // Sync snap_to_grid changes to backend
  const prevSnapRef = useRef(snapToGrid)
  useEffect(() => {
    if (!activeLayoutId) return
    if (prevSnapRef.current === snapToGrid) return
    prevSnapRef.current = snapToGrid
    updateSnap(activeLayoutId, snapToGrid)
  }, [snapToGrid, activeLayoutId, updateSnap])

  const handleToggleRegister = useCallback(() => {
    if (!activeLayoutId) return
    if (canvasRegistered) {
      unregisterCanvas(activeLayoutId)
    } else {
      registerCanvas(activeLayoutId, canvasWidth, canvasHeight)
    }
  }, [activeLayoutId, canvasRegistered, canvasWidth, canvasHeight, registerCanvas, unregisterCanvas])

  return (
    <div className="relative h-screen w-screen p-[10px] flex flex-col gap-[10px] overflow-hidden">
      {/* ── Top bar: layout selector (left) + controls (right) ── */}
      <div className="h-[48px] shrink-0 flex items-center gap-[10px]">
        {/* Left: layout dropdown + rename */}
        <LayoutSelector
          layouts={layouts}
          activeLayout={activeLayout}
          onSwitch={switchLayout}
          onCreate={createLayout}
          onDelete={deleteLayout}
        />

        {activeLayout && (
          <InlineEdit
            value={activeLayout.name}
            onCommit={name => renameLayout(activeLayout.id, name)}
          />
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right: grid size + register + snap */}
        <GridSizeInput
          label={t('gridSize.width')}
          ariaLabel={t('gridSize.widthLabel')}
          value={canvasWidth}
          onCommit={v => updateCanvasBounds({ width: v })}
          onEditStart={beginCanvasHistoryBatch}
          onEditEnd={endCanvasHistoryBatch}
        />
        <GridSizeInput
          label={t('gridSize.height')}
          ariaLabel={t('gridSize.heightLabel')}
          value={canvasHeight}
          onCommit={v => updateCanvasBounds({ height: v })}
          onEditStart={beginCanvasHistoryBatch}
          onEditEnd={endCanvasHistoryBatch}
        />
        <button
          className={cn(
            'h-[40px] px-[14px] rounded-[10px] border cursor-pointer transition-colors flex items-center justify-center gap-[6px] text-[13px] font-medium',
            canvasRegistered
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-secondary border-border hover:bg-accent',
          )}
          onClick={handleToggleRegister}
          title={canvasRegistered ? t('canvas.registered') : t('canvas.unregistered')}
        >
          <FilePlus2 className="size-4" />
          {canvasRegistered ? t('canvas.deactivate') : t('canvas.register')}
        </button>
        <button
          className={cn(
            'w-[40px] h-[40px] rounded-[10px] border cursor-pointer transition-colors flex items-center justify-center',
            snapToGrid
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-secondary border-border hover:bg-accent',
          )}
          onClick={toggleSnap}
          title={snapToGrid ? t('snap.on') : t('snap.off')}
        >
          <Magnet className="size-4" />
        </button>
      </div>

      {/* ── Bottom area: remaining height ── */}
      <div className="flex-1 flex gap-[10px] min-h-0">
        {/* Left panel – visual grid canvas */}
        <div className="flex-1 min-w-0 rounded-[10px] bg-card border border-border overflow-hidden">
          <VisualGrid />
        </div>

        {/* Right panel – device tree + layout manager */}
        <div className="shrink-0 min-h-0 flex flex-col gap-[10px]" style={{ width: 'clamp(260px, 26%, 380px)' }}>
          <div className="basis-1/2 min-h-0 rounded-[10px] bg-card border border-border/60 overflow-hidden">
            <DeviceTree />
          </div>
          <div className="basis-1/2 min-h-0 rounded-[10px] bg-card border border-border/60 overflow-hidden">
            <LayoutManager />
          </div>
        </div>
      </div>

      <div className="absolute left-[16px] bottom-[16px] z-30">
        <div className="group relative">
          <button
            type="button"
            className="flex h-[36px] w-[36px] items-center justify-center rounded-full border border-zinc-700 bg-zinc-800 text-zinc-100 transition-colors hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500/60"
            aria-label={t('canvas.help.ariaLabel')}
            aria-describedby="led-canvas-help"
          >
            <CircleHelp className="size-4" />
          </button>
          <div
            id="led-canvas-help"
            role="tooltip"
            className="pointer-events-none absolute bottom-[calc(100%+10px)] left-0 w-[280px] rounded-[12px] border border-zinc-700 bg-zinc-900 px-[12px] py-[10px] text-[12px] leading-[1.5] text-zinc-100 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            {t('canvas.help.description')}
          </div>
        </div>
      </div>
    </div>
  )
}

export default App

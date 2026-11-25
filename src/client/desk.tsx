/** The publishing desk: the Markdown documents of a configured directory, one of them open, and publishing it to Feishu. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Icon, Tag } from './controls.tsx'
import { deskApi, type DeskApi, type DeskBatchItem, type DeskFile, type DeskPreview, type DeskResult, type DeskRewrite, type DeskRoot } from './desk-api.ts'
import { usePanel } from './provider.tsx'
import { errorText, fullTime, type T } from './text.ts'
import { Hint, KeyValues, MarkdownLite, Section } from './widgets.tsx'

type Mode = 'preview' | 'edit'

/** The list of the documents of one directory, with a filter over their paths and a tick per document. */
function FileList({ files, current, filter, selected, onFilter, onPick, onToggle, onSelectAll }: {
  files: DeskFile[]; current: string | undefined; filter: string; selected: Set<string>
  onFilter: (filter: string) => void; onPick: (path: string) => void; onToggle: (path: string) => void
  onSelectAll: (paths: string[], selected: boolean) => void
}) {
  const { t } = usePanel()
  const query = filter.trim().toLowerCase()
  const shown = query ? files.filter(file => file.path.toLowerCase().includes(query)) : files
  const paths = shown.map(file => file.path)
  const all = paths.length > 0 && paths.every(path => selected.has(path))
  return <>
    <input className="dt-desk-filter" type="search" value={filter} aria-label={t('deskFilter')} placeholder={t('deskFilter')}
      onChange={event => onFilter(event.target.value)} />
    {shown.length ? <>
      <label className="dt-desk-tick"><input type="checkbox" checked={all} aria-label={t('deskSelectAll')}
        onChange={event => onSelectAll(paths, event.target.checked)} />
        <span>{t('deskSelectAll')}</span></label>
      <ul className="dt-list">{shown.map(file => <li key={file.path} className="dt-row dt-link">
        <div className="dt-row-main">
          <div className="dt-row-title"><label className="dt-desk-tick">
            <input type="checkbox" checked={selected.has(file.path)} aria-label={file.name}
              onChange={() => onToggle(file.path)} />
          </label>
          <button type="button" className="dt-open" aria-current={file.path === current}
            title={file.path} onClick={() => onPick(file.path)}>{file.name}</button></div>
          <div className="dt-row-meta"><span className="dt-ellipsis">{file.path}</span>
            <span>{t('deskFileBytes', { bytes: file.bytes })}</span></div>
        </div>
      </li>)}</ul></> : <Hint>{t('deskNoFiles')}</Hint>}
  </>
}

/** One open document: its text, its preview, and the actions that save or publish it. */
function Editor({ root, file, api, onPublish, onOpen, onRefresh }: {
  root: string; file: DeskFile; api: DeskApi
  onPublish: (path: string) => Promise<void>
  onOpen: (path: string) => void
  onRefresh: () => void
}) {
  const { t, notify } = usePanel()
  const [content, setContent] = useState<string>()
  const [saved, setSaved] = useState('')
  const [modified, setModified] = useState('')
  const [mode, setMode] = useState<Mode>('preview')
  const [preview, setPreview] = useState<DeskPreview>()
  const [busy, setBusy] = useState<'save' | 'publish' | 'rewrite' | undefined>()
  const [rewrite, setRewrite] = useState<DeskRewrite>()
  const dirty = content !== undefined && content !== saved
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  useEffect(() => {
    let live = true
    setContent(undefined); setPreview(undefined); setMode('preview')
    api.file(root, file.path).then(value => {
      if (!live) return
      setContent(value.content); setSaved(value.content); setModified(value.modified)
    }, failure => { if (live) notify(errorText(failure)) })
    return () => { live = false }
  }, [api, root, file.path, notify])
  // The preview shows what publishing makes of the text, so it follows the edits after a pause.
  const previewOf = useRef<number>(0)
  useEffect(() => {
    if (content === undefined) return
    const mine = ++previewOf.current
    const timer = setTimeout(() => {
      api.preview(content).then(value => { if (previewOf.current === mine) setPreview(value) },
        () => { if (previewOf.current === mine) setPreview(undefined) })
    }, 400)
    return () => clearTimeout(timer)
  }, [api, content])

  const save = useCallback(async () => {
    if (content === undefined) return
    setBusy('save')
    try {
      const written = await api.write(root, file.path, content)
      setSaved(content); setModified(written.modified); notify(t('deskSaved'))
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(undefined) }
  }, [api, root, file.path, content, notify, t])

  const publish = async () => {
    setBusy('publish')
    try {
      // Publishing reads the file, so unsaved text is written first.
      if (dirtyRef.current && content !== undefined) {
        const written = await api.write(root, file.path, content)
        setSaved(content); setModified(written.modified)
      }
      await onPublish(file.path)
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(undefined) }
  }

  /**
   * 把这篇文档改写成通俗版，产物写在它旁边。
   *
   * 改写是按节的：事实没变的节原样留着，所以改一次只动该动的地方。
   */
  const runRewrite = async () => {
    setBusy('rewrite')
    try {
      const value = await api.rewrite(root, file.path)
      setRewrite(value)
      // The new document joins the list beside the one that was read.
      onRefresh()
      if (value.upToDate) notify(t('deskRewriteUpToDate'))
      else if (value.problems.length) notify(t('deskRewriteProblems', { problems: value.problems.map(item => item.detail).join('、') }))
      else notify(t('deskRewriteDone', { file: value.output, count: value.changed.length }))
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(undefined) }
  }

  return <Section title={file.path} action={<div className="dt-actions">
    <Button variant={mode === 'edit' ? 'ghost' : 'outline'} size="sm" disabled={content === undefined}
      onClick={() => setMode(mode === 'edit' ? 'preview' : 'edit')}>{mode === 'edit' ? t('deskPreview') : t('deskEdit')}</Button>
  </div>}>
    <div className="dt-desk-meta">
      <Tag tone="neutral">{mode === 'edit' ? t('deskEdit') : t('deskPreview')}</Tag>
      {dirty && <Tag tone="warning">{t('deskUnsaved')}</Tag>}
      {modified && <span className="dt-hint">{fullTime(modified, t('lang'))}</span>}
    </div>
    {content === undefined ? <Hint>{t('loading')}</Hint> : mode === 'edit'
      ? <textarea className="dt-textarea dt-desk-editor" value={content} spellCheck={false} aria-label={file.name}
        onChange={event => setContent(event.target.value)} />
      : <MarkdownLite text={content} />}
    {preview && <p className="dt-hint">{t('deskBlocks', { before: preview.before, blocks: preview.blocks })} · {t('deskCut')}</p>}
    <div className="dt-actions dt-desk-actions">
      <Button variant="ghost" size="sm" disabled={!dirty || busy !== undefined} onClick={() => setContent(saved)}>{t('deskDiscard')}</Button>
      <Button variant="outline" size="sm" disabled={!dirty || busy !== undefined} onClick={() => { void save() }}>{t('deskSave')}</Button>
      <Button variant="outline" size="sm" disabled={content === undefined || busy !== undefined} onClick={() => { void runRewrite() }}>
        {busy === 'rewrite' ? t('deskRewriting') : t('deskRewrite')}</Button>
      <Button variant="primary" size="sm" icon={<Icon name="external" size={14} />} disabled={content === undefined || busy !== undefined}
        onClick={() => { void publish() }}>{busy === 'publish' ? t('deskPublishing')
          : file.doc_id ? t('deskPublishAgain') : t('deskPublish')}</Button>
    </div>
    {rewrite && <div className="dt-desk-rewrite">
      {rewrite.problems.length
        ? <Hint>{t('deskRewriteProblems', { problems: rewrite.problems.map(item => item.detail).join('、') })}</Hint>
        : <Hint>{rewrite.upToDate ? t('deskRewriteUpToDate') : t('deskRewriteDone', { file: rewrite.output, count: rewrite.changed.length })}</Hint>}
      {rewrite.baseline && <p className="dt-hint dt-mono">{t('deskRewriteBaseline', { baseline: rewrite.baseline })}</p>}
      {rewrite.text && <MarkdownLite text={rewrite.text} />}
      {!rewrite.upToDate && !rewrite.problems.length && rewrite.output && <div className="dt-actions">
        <Button variant="outline" size="sm" onClick={() => onOpen(rewrite.output)}>{t('deskRewriteOpen')}</Button>
      </div>}
    </div>}
    <Hint>{t('deskPublishHint')}</Hint>
  </Section>
}

/**
 * The publishing desk as a panel of its own.
 *
 * The sidebar carries it as a row beside Superagent, so it opens directly, without
 * the tabs of the other panel around it.
 */
export function DeskPanel() {
  const { t } = usePanel()
  return <div className="dt-page">
    <div className="dt-column">
      <header className="dt-head">
        <div className="dt-head-title"><h1 className="dt-title">{t('tab.desk')}</h1></div>
      </header>
      <main className="dt-main"><DeskPage /></main>
    </div>
  </div>
}

/** The desk page: a directory on the left, the open document and its publishing on the right. */
export function DeskPage() {
  const { t, notify } = usePanel()
  // The translator is read through a ref, so a language change does not make a new API object and refetch the desk.
  const copy = useRef(t)
  copy.current = t
  const api = useMemo(() => deskApi(((key, params) => copy.current(key, params)) as T), [])
  const [roots, setRoots] = useState<DeskRoot[]>()
  const [root, setRoot] = useState('')
  const [files, setFiles] = useState<DeskFile[]>([])
  const [filter, setFilter] = useState('')
  const [path, setPath] = useState<string>()
  const [error, setError] = useState<string>()
  const [result, setResult] = useState<{ path: string; value: DeskResult }>()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batch, setBatch] = useState<DeskBatchItem[]>()
  const [busy, setBusy] = useState(false)

  // The listing answers in order, and only for the directory on screen: a slow answer for a
  // directory the user has left must not repaint the list under the new one.
  const listing = useRef(0)
  const rootRef = useRef(root)
  rootRef.current = root
  const list = useCallback((directory: string) => {
    const mine = ++listing.current
    return api.files(directory).then(value => {
      if (listing.current !== mine || rootRef.current !== directory) return
      setFiles(value.files); setError(undefined)
    }, failure => {
      if (listing.current !== mine || rootRef.current !== directory) return
      setFiles([]); setError(errorText(failure))
    })
  }, [api])

  useEffect(() => {
    api.roots().then(value => {
      setRoots(value.roots)
      const first = value.roots[0]?.path
      // The ref is set with the state: the listing answers before React has painted the
      // new directory, and the ref is what says which directory the screen is on.
      if (first) { rootRef.current = first; setRoot(first); void list(first) }
    }, failure => setError(errorText(failure)))
  }, [api, list])

  const publish = async (relative: string): Promise<void> => {
    const directory = root
    try {
      const value = await api.publish(directory, relative)
      if (rootRef.current !== directory) return
      setResult({ path: relative, value })
      notify(t('deskPublished', { blocks: value.contentBlocks, images: value.images }))
      // The listing carries the document each path maps to, so it is refetched after a publication.
      void list(directory)
    } catch (failure) { if (rootRef.current === directory) notify(errorText(failure)) }
  }

  const toggle = (relative: string) => setSelected(current => {
    const next = new Set(current)
    if (next.has(relative)) next.delete(relative); else next.add(relative)
    return next
  })
  const selectAll = (paths: string[], on: boolean) => setSelected(current => {
    const next = new Set(current)
    for (const path of paths) { if (on) next.add(path); else next.delete(path) }
    return next
  })

  // Several documents publish at once; the host runs them in parallel and answers what each one did.
  const publishSelected = async () => {
    const paths = [...selected]
    if (!paths.length) return
    const directory = root
    setBusy(true)
    try {
      const value = await api.publishMany(directory, paths)
      if (rootRef.current !== directory) return
      setBatch(value.results)
      const ok = value.results.filter(item => item.ok).length
      const failed = value.results.length - ok
      notify(t('deskPublishedMany', { ok, failed }))
      void list(directory)
    } catch (failure) { if (rootRef.current === directory) notify(errorText(failure)) } finally { setBusy(false) }
  }

  const file = files.find(item => item.path === path)
  return <div className="dt-form">
    {error && <p className="dt-error" role="alert">{error}</p>}
    {roots && !roots.length && <Hint>{t('deskNoRoots')}</Hint>}
    <div className="dt-desk">
      <div className="dt-desk-side">
        {roots && roots.length > 1 && <select className="dt-select" aria-label={t('deskRoots')} value={root}
          onChange={event => { const next = event.target.value; rootRef.current = next; setRoot(next)
            setPath(undefined); setFiles([]); setError(undefined)
            setSelected(new Set()); setBatch(undefined); void list(next) }}>
          {roots.map(item => <option key={item.path} value={item.path}>{item.label}</option>)}
        </select>}
        {roots?.length === 1 && <p className="dt-hint dt-mono">{root}</p>}
        <FileList files={files} current={path} filter={filter} selected={selected} onFilter={setFilter}
          onPick={setPath} onToggle={toggle} onSelectAll={selectAll} />
        <div className="dt-actions dt-desk-actions">
          <span className="dt-hint">{t('deskSelected', { count: selected.size })}</span>
          <Button variant="primary" size="sm" icon={<Icon name="external" size={14} />} disabled={!selected.size || busy}
            onClick={() => { void publishSelected() }}>{busy ? t('deskPublishingMany', { count: selected.size })
              : t('deskPublishSelected')}</Button>
        </div>
      </div>
      <div className="dt-desk-main">
        {file ? <Editor key={file.path} root={root} file={file} api={api} onPublish={publish}
          onOpen={setPath} onRefresh={() => { void list(root) }} />
          : <Hint>{t('deskChooseFile')}</Hint>}
        {batch && <Section title={t('deskPublishSelected')} icon="external">
          <ul className="dt-list">{batch.map(item => <li key={item.path} className="dt-row">
            <div className="dt-row-main">
              <div className="dt-row-title"><span className="dt-row-label">{item.path}</span></div>
              <div className="dt-row-meta">{item.ok
                ? <a className="dt-inline-link" href={item.result.doc_url} target="_blank" rel="noopener noreferrer">
                  {item.result.doc_url}</a>
                : <span className="dt-error">{t('deskBatchFailed', { error: item.error })}</span>}</div>
            </div>
          </li>)}</ul>
        </Section>}
        {result && result.path === path && <Section title={result.value.title} icon="external">
          <Hint>{t('deskPublished', { blocks: result.value.contentBlocks, images: result.value.images })}</Hint>
          <KeyValues rows={[
            [t('deskPublishedOpen'), <a className="dt-inline-link" href={result.value.doc_url} target="_blank" rel="noopener noreferrer">
              {result.value.doc_url}</a>],
            [t('deskDocLink'), <span className="dt-mono">{result.value.doc_id}</span>],
            [t('deskOwner'), result.value.owner],
          ]} />
        </Section>}
      </div>
    </div>
    <Hint>{t('deskIntro')}</Hint>
  </div>
}

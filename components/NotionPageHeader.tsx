import type * as types from 'notion-types'
import cs from 'classnames'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { Breadcrumbs, Header, useNotionContext } from 'react-notion-x'

import { searchNotion } from '@/lib/search-notion'
import { isSearchEnabled, navigationLinks, navigationStyle } from '@/lib/config'
import { MoonIcon } from '@/lib/icons/moon'
import { SunIcon } from '@/lib/icons/sun'
import { useDarkMode } from '@/lib/use-dark-mode'

import styles from './styles.module.css'

// ─── Theme Toggle ────────────────────────────────────────────────────────────

function ToggleThemeButton() {
  const [hasMounted, setHasMounted] = React.useState(false)
  const { isDarkMode, toggleDarkMode } = useDarkMode()

  React.useEffect(() => {
    setHasMounted(true)
  }, [])

  return (
    <div
      className={cs('breadcrumb', 'button', !hasMounted && styles.hidden)}
      onClick={toggleDarkMode}
    >
      {hasMounted && isDarkMode ? <MoonIcon /> : <SunIcon />}
    </div>
  )
}

// ─── Search Modal (portaled to body) ─────────────────────────────────────────

function SearchModal({ onClose }: { onClose: () => void }) {
  const { components, mapPageUrl, rootPageId } = useNotionContext()
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState<any[]>([])
  const [searchResponse, setSearchResponse] = React.useState<any>(null)
  const [loading, setLoading] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
    return () => setMounted(false)
  }, [])
  React.useEffect(() => {
    if (mounted) setTimeout(() => inputRef.current?.focus(), 50)
  }, [mounted])
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  React.useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  const runSearch = React.useCallback(
    async (q: string) => {
      if (!q.trim() || !rootPageId) {
        setResults([])
        setSearchResponse(null)
        return
      }
      setLoading(true)
      try {
        const res = await searchNotion({
          query: q,
          ancestorId: rootPageId
        } as any)
        console.log('search full response:', res)
        setSearchResponse(res)
        setResults(Array.isArray(res?.results) ? res.results : [])
      } catch (err) {
        console.error('search error:', err)
        setResults([])
      } finally {
        setLoading(false)
      }
    },
    [rootPageId]
  )

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(val), 300)
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (debounceRef.current) clearTimeout(debounceRef.current)
    runSearch(query)
  }

  const getTitle = (r: any): string => {
    const pageId: string = r.id

    // Notion IDs in recordMap use dashed format
    const dashedId = pageId.replace(
      /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
      '$1-$2-$3-$4-$5'
    )

    // 1. Try recordMap with dashed ID (most reliable)
    try {
      const block =
        searchResponse?.recordMap?.block?.[dashedId]?.value ||
        searchResponse?.recordMap?.block?.[pageId]?.value
      const raw = block?.properties?.title
      if (raw) {
        // Notion title is an array of segments: [["text"], ["text", [["b"]]]]
        return raw.map((segment: any) => segment[0]).join('')
      }
    } catch {}

    // 2. Direct title on result
    try {
      if (r?.title) return String(r.title)
    } catch {}

    // 3. Highlight text — strip Notion XML tags like <gzkNfoUU>...</gzkNfoUU>
    try {
      if (r?.highlight?.text) {
        return r.highlight.text.replace(/<[^>]+>/g, '')
      }
    } catch {}

    return '(Untitled)'
  }

  const modalContent = (
    <div
      className={styles.modalBackdrop}
      onMouseDown={onClose}
      role='presentation'
    >
      <div
        className={styles.modalPanel}
        onMouseDown={(e) => e.stopPropagation()}
        role='dialog'
        aria-modal='true'
        aria-label='Search'
      >
        <form onSubmit={onSubmit} className={styles.modalSearchBar}>
          <svg
            className={styles.modalSearchIcon}
            width='18'
            height='18'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='2'
          >
            <circle cx='11' cy='11' r='8' />
            <path d='M21 21l-4.35-4.35' />
          </svg>
          <input
            ref={inputRef}
            className={styles.modalInput}
            value={query}
            onChange={onChange}
            placeholder='Search pages…'
            autoComplete='off'
            spellCheck={false}
          />
          {query && (
            <button
              type='button'
              className={styles.modalClearBtn}
              onClick={() => {
                setQuery('')
                setResults([])
                setSearchResponse(null)
                inputRef.current?.focus()
              }}
              aria-label='Clear'
            >
              ✕
            </button>
          )}
        </form>

        <div className={styles.modalDivider} />

        <div className={styles.modalResults}>
          {loading && (
            <div className={styles.modalEmpty}>
              <span className={styles.modalSpinner} />
              Searching…
            </div>
          )}
          {!loading && !query.trim() && (
            <div className={styles.modalEmpty}>Type to search your pages</div>
          )}
          {!loading && query.trim() && results.length === 0 && (
            <div className={styles.modalEmpty}>
              No results for{' '}
              <strong style={{ color: '#e2e8f0', marginLeft: 4 }}>
                "{query}"
              </strong>
            </div>
          )}
          {!loading &&
            results.length > 0 &&
            results.map((r: any) => {
              const pageId: string = r.id

              // Pull block value directly from the response's recordMap
              const blockValue =
                searchResponse?.recordMap?.block?.[pageId]?.value

              // Title: join all text segments from Notion's title array
              const title: string = (() => {
                const titleProp = blockValue?.properties?.title
                if (Array.isArray(titleProp) && titleProp.length > 0) {
                  return titleProp
                    .map((seg: any) => (Array.isArray(seg) ? seg[0] : ''))
                    .join('')
                }
                // Fallback: strip XML tags from highlight
                if (r?.highlight?.text)
                  return r.highlight.text.replace(/<[^>]+>/g, '')
                return '(Untitled)'
              })()

              // Subtitle: clean text from highlight (strip Notion's custom XML tags)
              const subtitle: string = (() => {
                const raw = r?.highlight?.text || r?.highlights?.text || ''
                return raw
                  .replace(/<[^>]+>/g, '')
                  .trim()
                  .slice(0, 100)
              })()

              // Block type for icon selection
              const blockType: string = blockValue?.type || 'page'

              return (
                <components.PageLink
                  key={pageId}
                  href={mapPageUrl(pageId)}
                  className={styles.modalResultItem}
                  onClick={onClose}
                >
                  <svg
                    width='15'
                    height='15'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='2'
                    className={styles.modalResultIcon}
                  >
                    {blockType === 'collection_view_page' ? (
                      // Database icon
                      <>
                        <rect x='3' y='3' width='18' height='4' rx='1' />
                        <rect x='3' y='10' width='18' height='4' rx='1' />
                        <rect x='3' y='17' width='18' height='4' rx='1' />
                      </>
                    ) : (
                      // Page icon
                      <>
                        <path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' />
                        <polyline points='14,2 14,8 20,8' />
                      </>
                    )}
                  </svg>

                  <div className={styles.modalResultContent}>
                    <span className={styles.modalResultTitle}>{title}</span>
                    {subtitle && title !== subtitle && (
                      <span className={styles.modalResultSubtitle}>
                        {subtitle}
                      </span>
                    )}
                  </div>

                  <span className={styles.modalResultArrow}>→</span>
                </components.PageLink>
              )
            })}
        </div>

        <div className={styles.modalFooter}>
          <kbd>↵</kbd> to open &nbsp;&nbsp;<kbd>Esc</kbd> to close
        </div>
      </div>
    </div>
  )

  if (!mounted) return null
  return ReactDOM.createPortal(modalContent, document.body)
}

// ─── Search Trigger Button ────────────────────────────────────────────────────

function SearchTrigger() {
  const [modalOpen, setModalOpen] = React.useState(false)

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setModalOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <button
        className={styles.searchTriggerBtn}
        onClick={() => setModalOpen(true)}
        aria-label='Open search'
      >
        <svg
          width='15'
          height='15'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
        >
          <circle cx='11' cy='11' r='8' />
          <path d='M21 21l-4.35-4.35' />
        </svg>
        <span>Search</span>
        <kbd className={styles.searchKbd}>⌘K</kbd>
      </button>

      {modalOpen && <SearchModal onClose={() => setModalOpen(false)} />}
    </>
  )
}

// ─── Main Header Export ───────────────────────────────────────────────────────

export function NotionPageHeader({
  block
}: {
  block: types.CollectionViewPageBlock | types.PageBlock
}) {
  const { components, mapPageUrl } = useNotionContext()

  if (navigationStyle === 'default') {
    return <Header block={block} />
  }

  return (
    <header className='notion-header'>
      <div className='notion-nav-header'>
        <Breadcrumbs block={block} rootOnly={true} />

        <div className='notion-nav-header-rhs breadcrumbs'>
          {navigationLinks
            ?.map((link, index) => {
              if (!link?.pageId && !link?.url) return null
              if (link.pageId) {
                return (
                  <components.PageLink
                    href={mapPageUrl(link.pageId)}
                    key={index}
                    className={cs(styles.navLink, 'breadcrumb', 'button')}
                  >
                    {link.title}
                  </components.PageLink>
                )
              } else {
                return (
                  <components.Link
                    href={link.url!}
                    key={index}
                    className={cs(styles.navLink, 'breadcrumb', 'button')}
                  >
                    {link.title}
                  </components.Link>
                )
              }
            })
            .filter(Boolean)}

          <ToggleThemeButton />
          {isSearchEnabled && <SearchTrigger />}
        </div>
      </div>
    </header>
  )
}

import {
  type ExtendedRecordMap,
  type SearchParams,
  type SearchResults
} from 'notion-types'
import { mergeRecordMaps } from 'notion-utils'
import pMap from 'p-map'
import pMemoize from 'p-memoize'

import {
  isPreviewImageSupportEnabled,
  navigationLinks,
  navigationStyle
} from './config'
import { getTweetsMap } from './get-tweets'
import { notion } from './notion-api'
import { getPreviewImageMap } from './preview-images'

// ---------------------------------------------------------------------------
// Navigation link pages (memoized)
// ---------------------------------------------------------------------------

const getNavigationLinkPages = pMemoize(
  async (): Promise<ExtendedRecordMap[]> => {
    const navigationLinkPageIds = (navigationLinks || [])
      .map((link) => link?.pageId)
      .filter(Boolean)

    if (navigationStyle !== 'default' && navigationLinkPageIds.length) {
      return pMap(
        navigationLinkPageIds,
        async (navigationLinkPageId) =>
          notion.getPage(navigationLinkPageId, {
            chunkLimit: 1,
            fetchMissingBlocks: false,
            fetchCollections: false,
            signFileUrls: false
          }),
        { concurrency: 4 }
      )
    }
    return []
  }
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBlockPropertyValue(
  blockVal: any,
  propertyId: string
): string | undefined {
  const raw =
    propertyId === 'title'
      ? blockVal?.properties?.title
      : blockVal?.properties?.[propertyId]

  if (Array.isArray(raw) && raw.length > 0) {
    return raw[0]?.[0] as string | undefined
  }
  return undefined
}

function getBlockDateValue(blockVal: any, propertyId: string): number {
  if (propertyId === 'created_time') return blockVal?.created_time ?? 0
  if (propertyId === 'last_edited_time') return blockVal?.last_edited_time ?? 0

  const raw = blockVal?.properties?.[propertyId]
  if (!Array.isArray(raw)) return 0

  for (const segment of raw) {
    const decorations = segment?.[1]
    if (!Array.isArray(decorations)) continue
    for (const dec of decorations) {
      if (dec?.[0] === 'd' && dec?.[1]?.start_date) {
        return new Date(dec[1].start_date).getTime()
      }
    }
  }
  return 0
}

function evaluateFilter(
  blockValue: string | undefined,
  operator: string,
  filterValue: string
): boolean {
  const bv = (blockValue ?? '').toLowerCase().trim()
  const fv = (filterValue ?? '').toLowerCase().trim()

  switch (operator) {
    case 'enum_is':
    case 'enum_contains':
    case 'string_is':
      return bv === fv
    case 'enum_is_not':
    case 'string_is_not':
      return bv !== fv
    case 'enum_does_not_contain':
      return !bv.includes(fv)
    case 'string_contains':
      return bv.includes(fv)
    case 'string_does_not_contain':
      return !bv.includes(fv)
    case 'string_starts_with':
      return bv.startsWith(fv)
    case 'string_ends_with':
      return bv.endsWith(fv)
    case 'is_empty':
      return !blockValue || bv === ''
    case 'is_not_empty':
      return !!blockValue && bv !== ''
    case 'checkbox_is':
      return bv === fv
    default:
      console.log(`⚠️ Unknown filter operator "${operator}", keeping block`)
      return true
  }
}

function compareBlocks(
  aVal: any,
  bVal: any,
  propertyId: string,
  propertyType: string,
  direction: 'ascending' | 'descending'
): number {
  let result = 0

  switch (propertyType) {
    case 'created_time':
    case 'last_edited_time':
    case 'date': {
      result =
        getBlockDateValue(aVal, propertyId) -
        getBlockDateValue(bVal, propertyId)
      break
    }
    case 'number': {
      const an = parseFloat(getBlockPropertyValue(aVal, propertyId) ?? '0')
      const bn = parseFloat(getBlockPropertyValue(bVal, propertyId) ?? '0')
      result = an - bn
      break
    }
    case 'checkbox': {
      const ac =
        (getBlockPropertyValue(aVal, propertyId) ?? '') === 'Yes' ? 1 : 0
      const bc =
        (getBlockPropertyValue(bVal, propertyId) ?? '') === 'Yes' ? 1 : 0
      result = ac - bc
      break
    }
    default: {
      const as_ = (getBlockPropertyValue(aVal, propertyId) ?? '').toLowerCase()
      const bs_ = (getBlockPropertyValue(bVal, propertyId) ?? '').toLowerCase()
      result = as_.localeCompare(bs_)
      break
    }
  }

  return direction === 'descending' ? -result : result
}

function sortBlockIds(
  blockIds: string[],
  recordMap: ExtendedRecordMap,
  schema: Record<string, { name: string; type: string }>,
  sorts: Array<{ property: string; direction: 'ascending' | 'descending' }>
): string[] {
  return [...blockIds].sort((aId, bId) => {
    const aBlock = recordMap.block[aId]
    const bBlock = recordMap.block[bId]
    const aVal = (aBlock as any)?.value?.value || (aBlock as any)?.value
    const bVal = (bBlock as any)?.value?.value || (bBlock as any)?.value

    for (const sort of sorts) {
      const propertyId = sort.property === '__title__' ? 'title' : sort.property
      const propertyType =
        sort.property === '__title__'
          ? 'title'
          : sort.property === 'created_time'
            ? 'created_time'
            : sort.property === 'last_edited_time'
              ? 'last_edited_time'
              : (schema[sort.property]?.type ?? 'text')

      const cmp = compareBlocks(
        aVal,
        bVal,
        propertyId,
        propertyType,
        sort.direction
      )
      if (cmp !== 0) return cmp
    }
    return 0
  })
}

// ---------------------------------------------------------------------------
// Core
//
// The ONLY views we should ever process are the ones that:
//   1. Exist in recordMap.collection_view  (Notion returned them)
//   2. AND have a corresponding entry in collection_query[collectionId]
//      (Notion actually fetched row data for them for this page render)
//
// This is the natural, reliable boundary. Views that belong to other pages
// or the parent database will NOT have a collection_query entry for the
// current render — so they are automatically excluded with zero guesswork
// about view_ids, parent_id, or UUID normalisation.
//
// NEVER delete from recordMap.block — it is a shared lookup store.
// Filters and sorts operate exclusively on viewQuery.blockIds (per-view).
// ---------------------------------------------------------------------------

function applyCollectionViewFiltersAndSorts(
  recordMap: ExtendedRecordMap
): ExtendedRecordMap {
  const collection = Object.values(recordMap.collection || {})[0] as any
  const schema: Record<string, { name: string; type: string }> =
    collection?.value?.value?.schema || collection?.value?.schema || {}

  const collectionId = Object.keys(recordMap.collection || {})[0]
  if (!collectionId) {
    console.log('⚠️ No collection found, skipping')
    return recordMap
  }

  console.log(`📦 Collection ID: ${collectionId}`)

  const collectionQuery = (recordMap.collection_query as any)?.[collectionId]
  if (!collectionQuery) {
    console.log('⚠️ No collection_query found, skipping')
    return recordMap
  }

  // ── The golden rule: only process views that have a collection_query entry ──
  // These are the ONLY views Notion fetched row data for in this page render.
  // Any view from another page or the parent database will be absent here.
  const activeViewIds = Object.keys(collectionQuery).filter(
    (viewId) => !!recordMap.collection_view?.[viewId]
  )

  console.log(`📄 Active views with query data: [${activeViewIds.join(', ')}]`)

  for (const viewId of activeViewIds) {
    const view = recordMap.collection_view[viewId]
    const viewValue = (view as any)?.value?.value || (view as any)?.value

    const propertyFilters: any[] = viewValue?.format?.property_filters ?? []
    const sorts: Array<{
      property: string
      direction: 'ascending' | 'descending'
    }> = viewValue?.query2?.sort ?? viewValue?.query?.sort ?? []

    const hasFilters = propertyFilters.length > 0
    const hasSorts = sorts.length > 0

    if (!hasFilters && !hasSorts) {
      console.log(`  ⏭️  View ${viewId}: no filters or sorts, skipping`)
      continue
    }

    const viewQuery = collectionQuery[viewId]

    // Determine if this is a grouped view or flat view
    const groupResults = viewQuery?.collection_group_results
    const isGrouped =
      Array.isArray(groupResults?.blockIds) && groupResults.blockIds.length > 0

    // Snapshot the current blockIds for this view — never touch recordMap.block
    let workingIds: string[] = isGrouped
      ? [...(groupResults.blockIds as string[])]
      : [...((viewQuery?.blockIds as string[]) ?? [])]

    if (!workingIds.length) {
      console.log(`  ⚠️ View ${viewId}: no blockIds, skipping`)
      continue
    }

    console.log(
      `\n🔎 View ${viewId} — ${workingIds.length} block(s) before processing`
    )

    // ── FILTERS ────────────────────────────────────────────────────────────
    // Narrow workingIds only. recordMap.block is NEVER mutated.
    // All filters are ANDed (Notion default).
    if (hasFilters) {
      console.log(`  🔍 ${propertyFilters.length} filter(s)`)

      workingIds = workingIds.filter((blockId) => {
        const block = recordMap.block[blockId]
        const val = (block as any)?.value?.value || (block as any)?.value

        if (!val) {
          console.log(
            `    ⚠️ Block ${blockId} missing from recordMap, excluding`
          )
          return false
        }

        return propertyFilters.every((pf) => {
          const propertyId: string = pf?.filter?.property
          const operator: string = pf?.filter?.filter?.operator ?? 'enum_is'
          const filterValue: string = pf?.filter?.filter?.value?.value

          if (!propertyId) return true
          if (
            filterValue === undefined &&
            !['is_empty', 'is_not_empty'].includes(operator)
          ) {
            return true
          }

          const propertyName = schema[propertyId]?.name ?? propertyId
          const propertyType = schema[propertyId]?.type ?? 'unknown'
          const blockPropertyValue = getBlockPropertyValue(val, propertyId)
          const passes = evaluateFilter(
            blockPropertyValue,
            operator,
            filterValue
          )

          console.log(
            `    ${passes ? '✅' : '❌'} ${blockId} | ` +
              `"${propertyName}" (${propertyType}) [${operator}] ` +
              `"${filterValue}" | actual: "${blockPropertyValue ?? ''}"`
          )

          return passes
        })
      })

      console.log(`  ✅ After filters: ${workingIds.length} block(s) remain`)
    }

    // ── SORTS ──────────────────────────────────────────────────────────────
    // Sort the already-filtered list so both operations see the same set.
    if (hasSorts && workingIds.length > 0) {
      console.log(`  🔀 ${sorts.length} sort(s)`)
      workingIds = sortBlockIds(workingIds, recordMap, schema, sorts)
      console.log(`  ✅ Sorted ${workingIds.length} block(s)`)
    }

    // ── WRITE BACK — per-view only, never global ───────────────────────────
    if (isGrouped) {
      groupResults.blockIds = workingIds
    } else {
      viewQuery.blockIds = workingIds
    }

    console.log(`  💾 View ${viewId} done — ${workingIds.length} block(s)`)
  }

  return recordMap
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getPage(pageId: string): Promise<ExtendedRecordMap> {
  let recordMap = await notion.getPage(pageId)

  recordMap = applyCollectionViewFiltersAndSorts(recordMap)

  if (navigationStyle !== 'default') {
    const navigationLinkRecordMaps = await getNavigationLinkPages()
    if (navigationLinkRecordMaps?.length) {
      recordMap = navigationLinkRecordMaps.reduce(
        (map, navigationLinkRecordMap) =>
          mergeRecordMaps(map, navigationLinkRecordMap),
        recordMap
      )
    }
  }

  if (isPreviewImageSupportEnabled) {
    const previewImageMap = await getPreviewImageMap(recordMap)
    ;(recordMap as any).preview_images = previewImageMap
  }

  await getTweetsMap(recordMap)

  return recordMap
}

export async function search(params: SearchParams): Promise<SearchResults> {
  return notion.search(params)
}

// used for rendering equations (optional)
import 'katex/dist/katex.min.css'
// used for code syntax highlighting (optional)
import 'prismjs/themes/prism-coy.css'
// core styles shared by all of react-notion-x (required)
import 'react-notion-x/styles.css'
// global styles shared across the entire site
import 'styles/global.css'
// global style overrides for notion
import 'styles/notion.css'
// global style overrides for prism theme (optional)
import 'styles/prism-theme.css'

import type { AppProps } from 'next/app'
import * as Fathom from 'fathom-client'
import { useRouter } from 'next/router'
import { posthog } from 'posthog-js'
import * as React from 'react'

import { bootstrap } from '@/lib/bootstrap-client'
import {
  fathomConfig,
  fathomId,
  isServer,
  posthogConfig,
  posthogId
} from '@/lib/config'

if (!isServer) {
  bootstrap()
}

// GA4 ID from env
const GA_ID = process.env.NEXT_PUBLIC_GA_ID

// helper to send GA pageview
const gtagPageview = (url: string) => {
  if (!GA_ID) return
  // @ts-ignore
  window.gtag?.('config', GA_ID, {
    page_path: url
  })
}

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter()

  React.useEffect(() => {
    function onRouteChangeComplete(url: string) {
      // Fathom
      if (fathomId) {
        Fathom.trackPageview()
      }

      // PostHog
      if (posthogId) {
        posthog.capture('$pageview')
      }

      // Google Analytics
      gtagPageview(url)
    }

    // init Fathom
    if (fathomId) {
      Fathom.load(fathomId, fathomConfig)
    }

    // init PostHog
    if (posthogId) {
      posthog.init(posthogId, posthogConfig)
    }

    // initial GA pageview on first load
    if (GA_ID) {
      gtagPageview(window.location.pathname)
    }

    router.events.on('routeChangeComplete', onRouteChangeComplete)
    return () => {
      router.events.off('routeChangeComplete', onRouteChangeComplete)
    }
  }, [router.events])

  return <Component {...pageProps} />
}

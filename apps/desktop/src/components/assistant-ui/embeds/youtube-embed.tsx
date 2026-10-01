'use client'

import { useEffect, useState } from 'react'

import { PrettyLink } from '@/lib/external-link'

import type { FrameEmbed } from './providers/types'
import { useIsDark } from './use-is-dark'

const YOUTUBE_ALLOW =
  'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen'

function youtubeSrc(embedUrl: string): string {
  const url = new URL(embedUrl)

  // Only pass origin when it is an HTTP(S) origin; custom schemes (app://,
  // file://) can make the player reject otherwise embeddable videos.
  if (
    typeof window !== 'undefined' &&
    (window.location.protocol === 'http:' || window.location.protocol === 'https:') &&
    window.location.origin &&
    window.location.origin !== 'null'
  ) {
    url.searchParams.set('origin', window.location.origin)
  }

  return url.toString()
}

// The packaged renderer is a file:// document, which YouTube refuses to embed
// into (no Referer → error 153). Electron serves a loopback page that frames
// the player from a real http origin (electron/youtube-embed-host.ts).
function hostedYouTubeSrc(embedUrl: string, hostOrigin: string): string {
  const player = new URL(embedUrl)
  const hosted = new URL(`/youtube-embed/${player.pathname.split('/').pop()}`, hostOrigin)
  const start = player.searchParams.get('start')

  if (start) {
    hosted.searchParams.set('start', start)
  }

  return hosted.toString()
}

// undefined while asking Electron for the host; null when it could not bind.
function usePlayerSrc(embedUrl: string): null | string | undefined {
  const resolveHostOrigin = window.hermesDesktop?.youtubeEmbedOrigin
  const [hostOrigin, setHostOrigin] = useState<null | string | undefined>(undefined)

  useEffect(() => {
    if (!resolveHostOrigin) {
      return
    }

    let live = true

    void resolveHostOrigin()
      .catch(() => null)
      .then(origin => live && setHostOrigin(origin))

    return () => {
      live = false
    }
  }, [resolveHostOrigin])

  // No desktop bridge (renderer opened in a plain browser): frame directly.
  if (!resolveHostOrigin) {
    return youtubeSrc(embedUrl)
  }

  return hostOrigin && hostedYouTubeSrc(embedUrl, hostOrigin)
}

// Keep this as a plain iframe and let YouTube render its native player/error UI.
export default function YouTubeEmbedRenderer({ descriptor }: { descriptor: FrameEmbed }) {
  const isDark = useIsDark()
  const src = usePlayerSrc(descriptor.embedUrl)

  if (src === null) {
    return <PrettyLink className="wrap-anywhere" href={descriptor.sourceUrl} />
  }

  if (src === undefined) {
    return <span className="block aspect-video w-full" />
  }

  // Width is capped to the ratio by UrlEmbed, so aspect-video sizes height ≤ cap.
  return (
    <iframe
      allow={YOUTUBE_ALLOW}
      allowFullScreen
      className="block aspect-video w-full border-0 bg-transparent"
      loading="lazy"
      referrerPolicy="strict-origin-when-cross-origin"
      scrolling="no"
      src={src}
      style={{ colorScheme: isDark ? 'dark' : 'light' }}
      title="YouTube embed"
    />
  )
}

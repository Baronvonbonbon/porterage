// Following the app's own theme.
//
// The host has a theme and Porterage was ignoring it: a phone set to dark
// opened a product in whatever `prefers-color-scheme` happened to say, which
// inside a WebView is not always the same answer. The host's subscription is
// the authoritative one, so it wins when it is there, and the media query is
// what is left when it is not.
//
// One attribute on the root element, which the stylesheet reads. Nothing else
// in the app knows about themes.

import { getThemeProvider } from "@parity/product-sdk-host";

export type Variant = "light" | "dark";

/** Start following the host's theme. Returns a function that stops. */
export async function followHostTheme(): Promise<() => void> {
  try {
    const provider = await getThemeProvider();
    if (!provider) return () => undefined;
    const sub = provider.subscribeTheme((theme) => {
      const variant = (theme as { variant?: string })?.variant;
      if (variant === "Dark" || variant === "Light") {
        document.documentElement.dataset.theme = variant.toLowerCase();
      }
    });
    return () => sub.unsubscribe();
  } catch {
    // No host, or a host that doesn't answer: the media query still applies.
    return () => undefined;
  }
}

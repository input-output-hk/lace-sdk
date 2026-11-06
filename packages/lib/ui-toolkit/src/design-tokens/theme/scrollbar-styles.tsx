import React from 'react';
import { Platform } from 'react-native';

import type { Theme } from './types';

// TrueSheet v3's scrollable web content root needs the body's definite height
// so its flex children scroll within the space left below the header.
const scrollableSheetContent =
  '[data-vaul-drawer] > [data-vaul-auto-size-wrapper] > div[style*="--snap-point-height"] > div:last-child > div';

// Document-wide rules also reach menus and sheets rendered through portals.
export const ScrollbarStyles = ({ theme }: { theme: Theme }) => {
  if (Platform.OS !== 'web') return null;

  return React.createElement('style', {
    'data-lace-scrollbars': theme.name,
    children: `
      * {
        scrollbar-color: ${theme.text.tertiary} transparent;
        scrollbar-width: auto;
      }
      @supports selector(::-webkit-scrollbar) {
        * { scrollbar-color: auto; }
        *::-webkit-scrollbar { width: 12px; height: 12px; }
        *::-webkit-scrollbar-track,
        *::-webkit-scrollbar-corner { background: transparent; }
        *::-webkit-scrollbar-thumb {
          background-color: ${theme.text.tertiary};
          background-clip: padding-box;
          border: 3px solid transparent;
          border-radius: 6px;
          min-width: 24px;
          min-height: 24px;
        }
      }
      @media (forced-colors: active) {
        * { scrollbar-color: auto; }
        *::-webkit-scrollbar-thumb { background-color: ButtonText; }
      }
      [data-vaul-detached-wrapper] { --lace-sheet-footer-height: 0px; }
      ${scrollableSheetContent} {
        height: 100%;
        min-height: 0;
        box-sizing: border-box;
        padding-bottom: var(--lace-sheet-footer-height, 0px);
      }
      /* Flow roots keep an inline window height for native and auto-sized sheets. */
      ${scrollableSheetContent} [data-lace-sheet-flow] {
        height: 100% !important;
        min-height: 0;
        padding-bottom: 0 !important;
      }
    `,
  });
};

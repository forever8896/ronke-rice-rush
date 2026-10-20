// Phosphor icons (bold weight), imported as raw SVG so only the ones the
// UI uses end up in the bundle. They paint in currentColor.

import trophy from '@phosphor-icons/core/assets/bold/trophy-bold.svg?raw';
import wallet from '@phosphor-icons/core/assets/bold/wallet-bold.svg?raw';
import envelope from '@phosphor-icons/core/assets/bold/envelope-simple-bold.svg?raw';
import play from '@phosphor-icons/core/assets/fill/play-fill.svg?raw';
import lock from '@phosphor-icons/core/assets/bold/lock-simple-bold.svg?raw';
import shield from '@phosphor-icons/core/assets/bold/shield-check-bold.svg?raw';
import pencil from '@phosphor-icons/core/assets/bold/pencil-simple-bold.svg?raw';
import signOut from '@phosphor-icons/core/assets/bold/sign-out-bold.svg?raw';
import timer from '@phosphor-icons/core/assets/bold/timer-bold.svg?raw';
import crown from '@phosphor-icons/core/assets/fill/crown-fill.svg?raw';
import arrowUpRight from '@phosphor-icons/core/assets/bold/arrow-up-right-bold.svg?raw';
import info from '@phosphor-icons/core/assets/bold/info-bold.svg?raw';
import close from '@phosphor-icons/core/assets/bold/x-bold.svg?raw';
import check from '@phosphor-icons/core/assets/bold/check-circle-bold.svg?raw';
import warning from '@phosphor-icons/core/assets/bold/warning-circle-bold.svg?raw';

const ICONS = {
  trophy, wallet, envelope, play, lock, shield, pencil, signOut, timer, crown, arrowUpRight, info, close, check, warning,
} as const;

export type IconName = keyof typeof ICONS;

/** An icon as an element, sized by the surrounding font (1em). */
export function icon(name: IconName, cls = ''): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `ico${cls ? ` ${cls}` : ''}`;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ICONS[name];
  return span;
}

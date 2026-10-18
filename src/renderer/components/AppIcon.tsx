import { HugeiconsIcon } from '@hugeicons/react';
import Add01Icon from '@hugeicons/core-free-icons/Add01Icon';
import AiBrain01Icon from '@hugeicons/core-free-icons/AiBrain01Icon';
import AiChat02Icon from '@hugeicons/core-free-icons/AiChat02Icon';
import Alert02Icon from '@hugeicons/core-free-icons/Alert02Icon';
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon';
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon';
import ArrowReloadHorizontalIcon from '@hugeicons/core-free-icons/ArrowReloadHorizontalIcon';
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon';
import ArrowUp02Icon from '@hugeicons/core-free-icons/ArrowUp02Icon';
import BookOpen01Icon from '@hugeicons/core-free-icons/BookOpen01Icon';
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon';
import Bookmark02Icon from '@hugeicons/core-free-icons/Bookmark02Icon';
import Books02Icon from '@hugeicons/core-free-icons/Books02Icon';
import CancelCircleIcon from '@hugeicons/core-free-icons/CancelCircleIcon';
import CircleIcon from '@hugeicons/core-free-icons/CircleIcon';
import CircleCheckIcon from '@hugeicons/core-free-icons/CircleCheckIcon';
import CircleDotIcon from '@hugeicons/core-free-icons/CircleDotIcon';
import Clock01Icon from '@hugeicons/core-free-icons/Clock01Icon';
import Copy01Icon from '@hugeicons/core-free-icons/Copy01Icon';
import DashboardSpeed02Icon from '@hugeicons/core-free-icons/DashboardSpeed02Icon';
import Delete02Icon from '@hugeicons/core-free-icons/Delete02Icon';
import File01Icon from '@hugeicons/core-free-icons/File01Icon';
import FileAddIcon from '@hugeicons/core-free-icons/FileAddIcon';
import Files02Icon from '@hugeicons/core-free-icons/Files02Icon';
import Folder01Icon from '@hugeicons/core-free-icons/Folder01Icon';
import FolderAddIcon from '@hugeicons/core-free-icons/FolderAddIcon';
import FolderRemoveIcon from '@hugeicons/core-free-icons/FolderRemoveIcon';
import FullScreenIcon from '@hugeicons/core-free-icons/FullScreenIcon';
import Globe02Icon from '@hugeicons/core-free-icons/Globe02Icon';
import GridViewIcon from '@hugeicons/core-free-icons/GridViewIcon';
import ListViewIcon from '@hugeicons/core-free-icons/ListViewIcon';
import Loading03Icon from '@hugeicons/core-free-icons/Loading03Icon';
import MinusSignIcon from '@hugeicons/core-free-icons/MinusSignIcon';
import NoteAddIcon from '@hugeicons/core-free-icons/NoteAddIcon';
import PencilEdit01Icon from '@hugeicons/core-free-icons/PencilEdit01Icon';
import MoreHorizontalIcon from '@hugeicons/core-free-icons/MoreHorizontalIcon';
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon';
import SearchRemoveIcon from '@hugeicons/core-free-icons/SearchRemoveIcon';
import Settings02Icon from '@hugeicons/core-free-icons/Settings02Icon';
import SourceCodeIcon from '@hugeicons/core-free-icons/SourceCodeIcon';
import StopIcon from '@hugeicons/core-free-icons/StopIcon';
import TableOfContentsIcon from '@hugeicons/core-free-icons/TableOfContentsIcon';
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon';
import UserSettings01Icon from '@hugeicons/core-free-icons/UserSettings01Icon';


/**
 * The renderer's icon vocabulary. Names are semantic (what the glyph means in
 * this product), not pictorial, so a glyph can be re-chosen without touching
 * call sites.
 */
const APP_ICONS = {
  'library-all': Files02Icon,
  'library-continue-reading': BookOpen01Icon,
  'library-recently-added': FileAddIcon,
  'library-recently-read': Clock01Icon,
  warning: Alert02Icon,
  outline: TableOfContentsIcon,
  'display-settings': Settings02Icon,
  bookmark: Bookmark02Icon,
  'add-note': NoteAddIcon,
  'more-horizontal': MoreHorizontalIcon,
  search: Search01Icon,
  'open-file': BookOpen01Icon,
  'import-from-files': File01Icon,
  'import-from-web': Globe02Icon,
  'web-search': Globe02Icon,
  'focus-mode': FullScreenIcon,
  'disclosure-collapsed': ArrowRight01Icon,
  'disclosure-expanded': ArrowDown01Icon,
  'menu-caret': ArrowDown01Icon,
  'chat-thread': AiChat02Icon,
  'ai-model': AiBrain01Icon,
  'reasoning-effort': DashboardSpeed02Icon,
  submenu: ArrowRight01Icon,
  'code-block': SourceCodeIcon,
  copy: Copy01Icon,
  'copy-success': Tick02Icon,
  'agent-working-directories': Folder01Icon,
  'agent-profiles': UserSettings01Icon,
  back: ArrowLeft01Icon,
  'file-edit': PencilEdit01Icon,
  add: Add01Icon,
  close: Cancel01Icon,
  send: ArrowUp02Icon,
  stop: StopIcon,
  forward: ArrowRight01Icon,
  'view-grid': GridViewIcon,
  'view-list': ListViewIcon,
  'previous-page': ArrowLeft01Icon,
  'next-page': ArrowRight01Icon,
  busy: Loading03Icon,
  'library-empty': Books02Icon,
  'no-results': SearchRemoveIcon,
  folder: Folder01Icon,
  'folder-add': FolderAddIcon,
  'folder-remove': FolderRemoveIcon,
  rename: PencilEdit01Icon,
  delete: Delete02Icon,
  check: Tick02Icon,
  retry: ArrowReloadHorizontalIcon,
  'status-pending': CircleIcon,
  'status-in-progress': CircleDotIcon,
  'status-complete': CircleCheckIcon,
  'status-failed': CancelCircleIcon,
  'zoom-in': Add01Icon,
  'zoom-out': MinusSignIcon,
} as const;

export type AppIconName = keyof typeof APP_ICONS;

type AppIconProps = {
  readonly name: AppIconName;
  /** Square edge length in CSS pixels. */
  readonly size?: number;
  readonly className?: string;
  /**
   * Only for a glyph that is the sole content of its control. Where adjacent
   * text or the control's own `aria-label` already names the action, leave this
   * unset and the icon is `aria-hidden`, so assistive technology reads the name
   * once.
   */
  readonly label?: string;
};

/**
 * Shared icon wrapper. The glyph paints in `currentColor`, so it tints with
 * whichever semantic text token its container carries and follows all six
 * themes — which is exactly what the emoji it replaces could not do.
 */
export function AppIcon({ name, size = 16, className, label }: AppIconProps) {
  return (
    <HugeiconsIcon
      icon={APP_ICONS[name]}
      size={size}
      color="currentColor"
      strokeWidth={1.8}
      className={className}
      data-icon={name}
      {...(label === undefined
        ? { 'aria-hidden': true, focusable: false }
        : { role: 'img', 'aria-label': label })}
    />
  );
}

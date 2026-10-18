import type { ReactElement, ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { ChatStoreContext, type ChatStore } from '../../src/renderer/stores/use-chat-store';

/** Renders `ui` against `store`, as `App` provides its one chat controller. */
export function renderWithChatStore(store: ChatStore, ui: ReactElement): RenderResult {
  return render(ui, {
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <ChatStoreContext.Provider value={store}>{children}</ChatStoreContext.Provider>
    ),
  });
}

/** A fresh user gesture supersedes a pending passage navigation. */
export function cancelPracticeNavigationOnInput(cancel: () => void): () => void {
  const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Ebook Content"]');
  const targets = [document, frame?.contentDocument].filter((target): target is Document => !!target);
  for (const target of targets) {
    target.addEventListener('pointerdown', cancel, true);
    target.addEventListener('wheel', cancel, true);
    target.addEventListener('keydown', cancel, true);
  }
  return () => {
    for (const target of targets) {
      target.removeEventListener('pointerdown', cancel, true);
      target.removeEventListener('wheel', cancel, true);
      target.removeEventListener('keydown', cancel, true);
    }
  };
}

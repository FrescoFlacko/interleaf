import { useEffect, useState } from 'react';
import type { LearningSource, LearningSourceStatus } from '@shared/schemas/learning';
import { bridge } from '../../../app/api-client';

type Props = {
  readonly ownerId: string;
  readonly source: LearningSource;
  readonly label: string;
  readonly onFollow: (source: LearningSource) => void;
};

export function LearningSourceReference({ ownerId, source, label, onFollow }: Props) {
  const [details, setDetails] = useState<LearningSourceStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setDetails(null);
    setFailed(false);
    void bridge.learning.sourceStatus(ownerId, source).then((result) => {
      if (active) setDetails(result);
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => { active = false; };
  }, [ownerId, source]);
  return <div className="mt-2">
    <p className="font-medium">{details?.title ?? (failed ? 'Source status unavailable' : details?.status === 'missing' ? 'Source document unavailable' : 'Checking source…')}</p>
    <p>“{source.anchor.quote.exact}”</p>
    {details?.status === 'stale' && <p>Source has changed.</p>}
    {details?.status === 'missing' && <p>Source is unavailable (document ID: {source.documentId}).</p>}
    <button type="button" className="underline" disabled={details?.status !== 'current'} onClick={() => { onFollow(source); }}>{label}</button>
  </div>;
}

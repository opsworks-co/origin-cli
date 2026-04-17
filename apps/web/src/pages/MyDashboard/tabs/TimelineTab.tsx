import { Session } from '../utils';
import { SessionTimeline } from '../SessionTimeline';

export function TimelineTab({
  timelineLoading,
  timelineSessions,
  navigate,
}: {
  timelineLoading: boolean;
  timelineSessions: Session[];
  navigate: (path: string) => void;
}) {
  return (
        <div data-tour="tab-content-timeline">
          {timelineLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="animate-pulse">
                  <div className="h-4 w-32 bg-gray-800 rounded mb-3" />
                  <div className="ml-4 pl-6 border-l-2 border-gray-800 space-y-3">
                    {Array.from({ length: 2 }).map((_, j) => (
                      <div key={j} className="h-16 bg-gray-800/50 rounded-lg" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <SessionTimeline sessions={timelineSessions} navigate={navigate} />
          )}
        </div>
  );
}

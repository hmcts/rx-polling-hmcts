import { Observable, fromEvent, interval, timer, empty, concat } from 'rxjs';

import { tap, retryWhen, scan, startWith, switchMap, take, repeat } from 'rxjs/operators';

export interface IOptions {
  /**
   * Period of the interval to run the source$
   */
  interval: number;

  /**
   * How many attempts on error, before throwing definitely to polling subscriber
   */
  attempts?: number;

  /**
   * Strategy taken on source$ errors, with attempts to recover.
   *
   * 'exponential' will retry waiting an increasing exponential time between attempts.
   * You can pass the unit amount, which will be multiplied to the exponential factor.
   *
   * 'random' will retry waiting a random time between attempts. You can pass the range of randomness.
   *
   * 'consecutive' will retry waiting a constant time between attempts. You can
   * pass the constant, otherwise the polling interval will be used.
   */
  backoffStrategy?: 'exponential' | 'random' | 'consecutive';

  /**
   * Exponential delay factors (2, 4, 16, 32...) will be multiplied to the unit
   * to get final amount if 'exponential' strategy is used.
   */
  exponentialUnit?: number;

  /**
   * Range of milli-seconds to pick a random delay between error retries if 'random'
   * strategy is used.
   */
  randomRange?: [number, number] | undefined;

  /**
   * Constant time to delay error retries if 'consecutive' strategy is used
   */
  constantTime?: number;

  /**
   * Flag to enable background polling, ie polling even when the browser is inactive.
   */
  backgroundPolling?: boolean;
}

const defaultOptions: Partial<IOptions> = {
  attempts: 9,
  backoffStrategy: 'exponential',
  exponentialUnit: 1000, // 1 second
  randomRange: [1000, 10000],
  backgroundPolling: false
};

/**
 * Run a polling stream for the source$
 * @param request$ Source Observable which will be ran every interval
 * @param userOptions Polling options
 */
export function polling<T>(request$: Observable<T>, userOptions: IOptions): Observable<T> {
  const options = Object.assign({}, defaultOptions, userOptions);

  /**
   * Currently any new error, after recover, continues the series of  increasing
   * delays, like 2 consequent errors would do. This is a bug of RxJS. To workaround
   * the issue we use the difference with the counter value at the last recover.
   * @see https://github.com/ReactiveX/rxjs/issues/1413
   */
  let allErrorsCount = 0;
  let lastRecoverCount = 0;

  return fromEvent(document, 'visibilitychange').pipe(
    startWith(null),
    switchMap(() => {
      if (isPageActive() || options.backgroundPolling) {
        const firstRequest$ = request$;
        const polling$ = interval(options.interval).pipe(
          take(1),
          switchMap(() => request$),
          repeat()
        );

        return concat(firstRequest$, polling$).pipe(
          retryWhen(errors$ => {
            return errors$.pipe(
              scan(
                ({ errorCount }, err) => {
                  return { errorCount: errorCount + 1, error: err };
                },
                { errorCount: 0, error: null }
              ),
              switchMap(({ errorCount, error }) => {
                allErrorsCount = errorCount;
                const consecutiveErrorsCount = allErrorsCount - lastRecoverCount;

                // If already tempted too many times don't retry
                if (consecutiveErrorsCount > options.attempts) throw error;

                const delay = getStrategyDelay(consecutiveErrorsCount, options);

                return timer(delay, null);
              })
            );
          })
        );
      }

      return empty();
    }),
    tap<T>(() => {
      // Update the counter after every successful polling
      lastRecoverCount = allErrorsCount;
    })
  );
}

function isPageActive(): boolean {
  return !document.hidden;
}

function getStrategyDelay(consecutiveErrorsCount: number, options: IOptions): number {
  switch (options.backoffStrategy) {
    case 'exponential':
      return Math.pow(2, consecutiveErrorsCount - 1) * options.exponentialUnit;
    case 'random':
      // eslint-disable-next-line no-case-declarations
      const [min, max] = options.randomRange;

      // eslint-disable-next-line no-case-declarations
      const range = max - min;
      return Math.floor(Math.random() * range) + min;
    case 'consecutive':
      return options.constantTime || options.interval;
    default:
      console.error(`${options.backoffStrategy} is not a backoff strategy supported by rx-polling`);
      return options.constantTime || options.interval;
  }
}

import { dayParts } from '../src/components/ui';

test('the server day key is shown as a Japanese date and weekday without the device time zone', () => {
  expect(dayParts('2026-10-30')).toEqual({
    year: 2026,
    date: '10月30日',
    weekday: '金',
  });
  expect(dayParts('2026-11-01').weekday).toBe('日');
});

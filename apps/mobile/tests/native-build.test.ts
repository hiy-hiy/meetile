const { setFirebaseCocoaPods } = jest.requireActual<{
  setFirebaseCocoaPods: (contents: string) => string;
}>('../plugins/with-firebase-cocoapods.cjs');

test('selects CocoaPods before native pods are declared and survives regeneration', () => {
  const podfile = [
    'prepare_react_native_project!',
    "target 'puzzlesns' do",
    '  use_native_modules!',
    '  use_frameworks! :linkage => :static',
    'end',
    '',
  ].join('\n');
  const result = setFirebaseCocoaPods(podfile);
  expect(result.indexOf('$RNFirebaseDisableSPM = true')).toBeLessThan(
    result.indexOf("target 'puzzlesns'"),
  );
  expect(result).toContain(podfile);
  expect(setFirebaseCocoaPods(result)).toBe(result);
  expect(
    setFirebaseCocoaPods(`$RNFirebaseDisableSPM = false\n${podfile}`),
  ).toBe(result);
});

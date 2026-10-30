function runtimeFiles(mode = 'cloud', variant = 'development') {
  if (!['cloud', 'local'].includes(mode)) throw new Error('Unknown app mode');
  if (mode === 'local' && variant !== 'development')
    throw new Error('Local runtime requires development');
  const folder = mode === 'local' ? 'local' : 'cloud';
  return {
    ...(mode === 'local'
      ? {
          '@puzzle-sns/gallery-demo-assets':
            'src/local/gallery-demo/no-assets.ts',
        }
      : {}),
    '@puzzle-sns/proximity-observer': `src/${folder}/proximity-observer.ts`,
    '@puzzle-sns/app-layout': `src/${folder}/layout.tsx`,
    '@puzzle-sns/app-today': `src/${folder}/${mode === 'local' ? 'connection' : 'today'}.tsx`,
    '@puzzle-sns/app-settings': `src/${folder}/${mode === 'local' ? 'connection' : 'settings'}.tsx`,
  };
}
module.exports = { runtimeFiles };

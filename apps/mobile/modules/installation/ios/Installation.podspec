Pod::Spec.new do |s|
  s.name = 'Installation'
  s.version = '0.0.0'
  s.swift_version = '5.9'
  s.summary = 'Backup-excluded installation marker'
  s.description = 'Resets residual local credentials on reinstall before requests.'
  s.author = 'puzzle-sns'
  s.homepage = 'https://expo.dev'
  s.platforms = { :ios => '16.4' }
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
end

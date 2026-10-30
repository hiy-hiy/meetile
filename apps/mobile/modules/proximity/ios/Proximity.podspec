Pod::Spec.new do |s|
  s.name = 'Proximity'
  s.version = '0.0.0'
  s.swift_version = '5.9'
  s.summary = 'Foreground-only FIT radio observations'
  s.description = 'Core Bluetooth token exchange and Nearby Interaction for FIT.'
  s.author = 'puzzle-sns'
  s.homepage = 'https://expo.dev'
  s.platforms = { :ios => '16.4' }
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreBluetooth', 'NearbyInteraction'
  s.source_files = '**/*.{h,m,mm,swift}'
end

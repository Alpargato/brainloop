/**
 * Config plugin de Brainloop: elimina los intent-filter VIEW (deep links) que
 * `expo prebuild` añade por defecto a MainActivity con el esquema del package.
 * Brainloop no usa enlaces profundos, así que otras apps no podrán abrirla con URLs.
 */
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withNoDeepLinks(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    for (const activity of application?.activity ?? []) {
      if (!activity['intent-filter']) continue;
      activity['intent-filter'] = activity['intent-filter'].filter(
        (filter) =>
          !(filter.action ?? []).some((a) => a.$['android:name'] === 'android.intent.action.VIEW')
      );
    }
    return cfg;
  });
};

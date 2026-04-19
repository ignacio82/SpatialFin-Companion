const DEFAULT_PREFERENCES = {
  // Language
  pref_audio_language: "jpn",
  pref_subtitle_language: "eng",
  pref_anime_audio_language: "jpn",
  pref_anime_subtitle_language: "eng",
  pref_non_anime_audio_language: "eng",
  pref_non_anime_subtitle_disabled: "true",
  pref_non_anime_subtitle_language: null,
  pref_smart_prefer_original_audio: "true",
  pref_smart_spoken_languages: "en,es,ja",

  // Interface
  pref_theme: "system",
  pref_dynamic_colors: "true",
  home_suggestions: "true",
  home_continue_watching: "true",
  home_next_up: "true",
  home_latest: "true",
  pref_display_extra_info: "false",
  pref_display_ratings: "true",

  // Player
  pref_player_seek_back_inc: "5000",
  pref_player_seek_forward_inc: "15000",
  pref_player_chapter_markers: "true",
  pref_player_trickplay: "true",
  pref_player_max_bitrate: "0",
  pref_libass_subtitle_usage: "auto",
  pref_logging_enabled: "false",

  // Voice
  pref_voice_control_enabled: "true",
  pref_voice_gesture_hand: "left",
  pref_voice_assistant_verbosity: "balanced",
  pref_voice_assistant_spoiler_policy: "cautious",
  pref_voice_assistant_spoken_replies: "true",
  pref_voice_assistant_cloud_api_key: null,
  pref_voice_assistant_gemma_enabled: "false",

  // Seerr
  pref_seerr_enabled: "false",
  pref_seerr_url: null,
  pref_seerr_api_key: null,

  // TMDB / OMDb
  pref_tmdb_api_key: null,
  pref_tmdb_auto_match: "true",
  pref_omdb_api_key: null
};

module.exports = {
  DEFAULT_PREFERENCES
};

# libcrypt: the pattern dialog hashes the new password (yescrypt) for AccountsService
surya_crypt_dep = meson.get_compiler('c').find_library('crypt')
surya_math_dep = meson.get_compiler('c').find_library('m', required: false)

surya_plugin = shared_module(
  'ms-plugin-surya',
  files('ms-plugin-surya.c', 'ms-plugin-surya-panel.c', 'ms-plugin-surya-panel.h',
        'ms-plugin-surya-pattern.c', 'ms-plugin-surya-pattern.h'),
  dependencies: [adwaita_dep, gio_dep, glib_dep, gtk_dep, mobile_settings_plugin_dep, surya_crypt_dep, surya_math_dep],
  c_args: ['-DG_LOG_DOMAIN="ms-plugin-surya"'],
  include_directories: ms_plugin_inc,
  install: true,
  install_dir: ms_plugins_dir,
)

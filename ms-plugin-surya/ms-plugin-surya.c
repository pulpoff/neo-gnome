/*
 * Mobile Settings device page for the POCO X3 NFC (xiaomi,surya)
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

#define G_LOG_DOMAIN "ms-plugin-surya"

#include "ms-plugin.h"

#include "ms-plugin-surya-panel.h"

#include <gio/gio.h>

char **g_io_ms_plugin_surya_query (void);


void
g_io_module_load (GIOModule *module)
{
  const char * const supported[] = { "xiaomi,surya", "xiaomi,karna", NULL };

  g_type_module_use (G_TYPE_MODULE (module));

  if (ms_plugin_check_device_support (supported) == FALSE)
    return;

  g_io_extension_point_implement (MS_EXTENSION_POINT_DEVICE_PANEL,
                                  MS_TYPE_PLUGIN_SURYA_PANEL,
                                  "device-panel-surya",
                                  10);
}


void
g_io_module_unload (GIOModule *module)
{
}


char **
g_io_ms_plugin_surya_query (void)
{
  char *extension_points[] = { MS_EXTENSION_POINT_DEVICE_PANEL, NULL };

  return g_strdupv (extension_points);
}

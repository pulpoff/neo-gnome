/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

#pragma once

#include <ms-plugin.h>

G_BEGIN_DECLS

#define MS_TYPE_PLUGIN_SURYA_PANEL (ms_plugin_surya_panel_get_type ())

G_DECLARE_FINAL_TYPE (MsPluginSuryaPanel, ms_plugin_surya_panel, MS, PLUGIN_SURYA_PANEL, MsPluginPanel)

G_END_DECLS

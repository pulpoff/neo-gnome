/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

#pragma once

#include <gtk/gtk.h>

G_BEGIN_DECLS

/* ok: the pattern was confirmed and is now the user's password */
typedef void (*MsPatternDone) (gboolean ok, gpointer user_data);

void ms_pattern_dialog_present (GtkWidget *parent, MsPatternDone callback, gpointer user_data);

G_END_DECLS

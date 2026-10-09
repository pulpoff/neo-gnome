/*
 * "Set pattern" (POCO X3 NFC page, Screen lock): draw an unlock pattern, draw it again to confirm, and it becomes
 * the user's password: the dots joined in order as digits ("1478"), which the patched Phosh lock screen sends to
 * PAM when the same pattern is drawn there. The password is set through AccountsService, whose polkit policy
 * asks for the current password first.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */



#include "ms-plugin-surya-pattern.h"

#include <adwaita.h>
#include <crypt.h>
#include <math.h>
#include <unistd.h>

#define MIN_DOTS 4

typedef enum {
  STAGE_DRAW,
  STAGE_CONFIRM,
} Stage;

typedef struct {
  AdwDialog      *dialog;
  GtkWidget      *area;
  GtkWidget      *message;
  GtkWidget      *cancel;
  GtkWidget      *next;
  Stage           stage;
  char            seq[10];
  guint           len;
  char            first[10];
  double          x, y;
  gboolean        drawing;
  gboolean        error;
  gboolean        done;
  MsPatternDone   callback;
  gpointer        user_data;
} PatternDialog;


static void
geometry (GtkWidget *w, double *x0, double *y0, double *cell)
{
  double width = gtk_widget_get_width (w), height = gtk_widget_get_height (w);
  double side = MIN (width, height);

  *cell = side / 3.0;
  *x0 = (width - side) / 2.0;
  *y0 = (height - side) / 2.0;
}


static void
dot_center (GtkWidget *w, guint dot, double *cx, double *cy)
{
  double x0, y0, cell;

  geometry (w, &x0, &y0, &cell);
  *cx = x0 + cell * (dot % 3) + cell / 2.0;
  *cy = y0 + cell * (dot / 3) + cell / 2.0;
}


static gboolean
has_dot (PatternDialog *pd, guint dot)
{
  for (guint i = 0; i < pd->len; i++) {
    if (pd->seq[i] == '1' + dot)
      return TRUE;
  }
  return FALSE;
}


static void
append_dot (PatternDialog *pd, guint dot)
{
  if (pd->len >= 9 || has_dot (pd, dot))
    return;
  pd->seq[pd->len++] = '1' + dot;
  pd->seq[pd->len] = '\0';
}


/* as on the lock screen (and Android): a dot passed over on the way joins the pattern first */
static void
hit (PatternDialog *pd, double x, double y)
{
  double x0, y0, cell;

  geometry (pd->area, &x0, &y0, &cell);
  for (guint dot = 0; dot < 9; dot++) {
    double cx, cy;

    dot_center (pd->area, dot, &cx, &cy);
    if (hypot (x - cx, y - cy) > cell * 0.3 || has_dot (pd, dot))
      continue;
    if (pd->len > 0) {
      guint last = pd->seq[pd->len - 1] - '1';
      int dr = (int)(dot / 3) - (int)(last / 3), dc = (int)(dot % 3) - (int)(last % 3);

      if (dr % 2 == 0 && dc % 2 == 0)
        append_dot (pd, last + (dr / 2) * 3 + dc / 2);
    }
    append_dot (pd, dot);
    return;
  }
}


static void
draw_func (GtkDrawingArea *area, cairo_t *cr, int width, int height, gpointer data)
{
  PatternDialog *pd = data;
  GtkWidget *w = GTK_WIDGET (area);
  double x0, y0, cell, cx, cy;
  GdkRGBA fg;

  geometry (w, &x0, &y0, &cell);
  gtk_widget_get_color (w, &fg);
  if (pd->len > 0) {
    if (pd->error)
      cairo_set_source_rgba (cr, 0.88, 0.11, 0.14, 0.9);
    else
      cairo_set_source_rgba (cr, 0.21, 0.52, 0.89, 0.9);
    cairo_set_line_width (cr, cell * 0.05);
    cairo_set_line_cap (cr, CAIRO_LINE_CAP_ROUND);
    cairo_set_line_join (cr, CAIRO_LINE_JOIN_ROUND);
    for (guint i = 0; i < pd->len; i++) {
      dot_center (w, pd->seq[i] - '1', &cx, &cy);
      if (i == 0)
        cairo_move_to (cr, cx, cy);
      else
        cairo_line_to (cr, cx, cy);
    }
    if (pd->drawing)
      cairo_line_to (cr, pd->x, pd->y);
    cairo_stroke (cr);
  }
  for (guint dot = 0; dot < 9; dot++) {
    gboolean on = has_dot (pd, dot);

    dot_center (w, dot, &cx, &cy);
    if (on && pd->error)
      cairo_set_source_rgba (cr, 0.88, 0.11, 0.14, 1.0);
    else if (on)
      cairo_set_source_rgba (cr, 0.21, 0.52, 0.89, 1.0);
    else
      cairo_set_source_rgba (cr, fg.red, fg.green, fg.blue, 0.85);
    cairo_arc (cr, cx, cy, cell * (on ? 0.08 : 0.055), 0, 2 * G_PI);
    cairo_fill (cr);
  }
}


static void
set_stage (PatternDialog *pd, Stage stage)
{
  pd->stage = stage;
  pd->len = 0;
  pd->seq[0] = '\0';
  pd->error = FALSE;
  if (stage == STAGE_DRAW) {
    gtk_label_set_text (GTK_LABEL (pd->message), "Draw your unlock pattern. It becomes your password: connect at least 4 dots.");
    gtk_button_set_label (GTK_BUTTON (pd->next), "Continue");
  } else {
    gtk_label_set_text (GTK_LABEL (pd->message), "Draw the pattern again to confirm.");
    gtk_button_set_label (GTK_BUTTON (pd->next), "Confirm");
  }
  gtk_widget_set_sensitive (pd->next, FALSE);
  gtk_widget_queue_draw (pd->area);
}


static void
on_drag_begin (GtkGestureDrag *drag, double x, double y, PatternDialog *pd)
{
  pd->len = 0;
  pd->seq[0] = '\0';
  pd->error = FALSE;
  pd->drawing = TRUE;
  pd->x = x;
  pd->y = y;
  /* the touch is the pattern's: the dialog's own drag (a bottom sheet swipes down to close) took it after the
   * first dot and the pattern ended there */
  gtk_gesture_set_state (GTK_GESTURE (drag), GTK_EVENT_SEQUENCE_CLAIMED);
  gtk_widget_set_sensitive (pd->next, FALSE);
  hit (pd, x, y);
  gtk_widget_queue_draw (pd->area);
}


static void
on_drag_update (GtkGestureDrag *drag, double dx, double dy, PatternDialog *pd)
{
  double sx, sy;

  gtk_gesture_drag_get_start_point (drag, &sx, &sy);
  pd->x = sx + dx;
  pd->y = sy + dy;
  hit (pd, pd->x, pd->y);
  gtk_widget_queue_draw (pd->area);
}


static void
on_drag_end (GtkGestureDrag *drag, double dx, double dy, PatternDialog *pd)
{
  pd->drawing = FALSE;
  if (pd->len == 0)
    return;
  if (pd->len < MIN_DOTS) {
    pd->error = TRUE;
    gtk_label_set_text (GTK_LABEL (pd->message), "Connect at least 4 dots. Try again.");
  } else if (pd->stage == STAGE_CONFIRM && g_strcmp0 (pd->seq, pd->first) != 0) {
    pd->error = TRUE;
    gtk_label_set_text (GTK_LABEL (pd->message), "That was a different pattern. Try again.");
  } else {
    gtk_label_set_text (GTK_LABEL (pd->message),
                        pd->stage == STAGE_DRAW ? "Pattern recorded." : "Your unlock pattern has been set as:");
    gtk_widget_set_sensitive (pd->next, TRUE);
  }
  gtk_widget_queue_draw (pd->area);
}


static void
finish (PatternDialog *pd, gboolean ok)
{
  if (pd->done)
    return;
  pd->done = TRUE;
  if (pd->callback)
    pd->callback (ok, pd->user_data);
  adw_dialog_force_close (pd->dialog);
}


/* --- setting the password through AccountsService ------------------------------------------------------------- */

static void
on_password_set (GObject *source, GAsyncResult *res, gpointer data)
{
  PatternDialog *pd = data;
  g_autoptr (GError) error = NULL;
  g_autoptr (GVariant) ret = g_dbus_connection_call_finish (G_DBUS_CONNECTION (source), res, &error);

  if (!ret) {
    g_warning ("Setting the password failed: %s", error->message);
    gtk_label_set_text (GTK_LABEL (pd->message), "The password was not changed (not authorized?). Try again.");
    gtk_widget_set_sensitive (pd->next, TRUE);
    gtk_widget_set_sensitive (pd->cancel, TRUE);
    return;
  }
  finish (pd, TRUE);
}


static void
on_user_found (GObject *source, GAsyncResult *res, gpointer data)
{
  PatternDialog *pd = data;
  g_autoptr (GError) error = NULL;
  g_autoptr (GVariant) ret = g_dbus_connection_call_finish (G_DBUS_CONNECTION (source), res, &error);
  g_autofree char *salt = NULL;
  const char *path, *hashed;

  if (!ret) {
    g_warning ("AccountsService has no user: %s", error->message);
    gtk_label_set_text (GTK_LABEL (pd->message), "AccountsService is not available: the password was not changed.");
    gtk_widget_set_sensitive (pd->cancel, TRUE);
    return;
  }
  g_variant_get (ret, "(&o)", &path);
  /* yescrypt, as passwd writes it */
  salt = g_strdup (crypt_gensalt ("$y$", 0, NULL, 0));
  hashed = salt ? crypt (pd->first, salt) : NULL;
  if (!hashed || hashed[0] == '*') {
    gtk_label_set_text (GTK_LABEL (pd->message), "Could not hash the password.");
    gtk_widget_set_sensitive (pd->cancel, TRUE);
    return;
  }
  /* AccountsService's polkit policy asks for the current password (Phosh's prompt) */
  g_dbus_connection_call (G_DBUS_CONNECTION (source), "org.freedesktop.Accounts", path,
                          "org.freedesktop.Accounts.User", "SetPassword",
                          g_variant_new ("(ss)", hashed, ""), NULL,
                          G_DBUS_CALL_FLAGS_ALLOW_INTERACTIVE_AUTHORIZATION, 120000, NULL,
                          on_password_set, pd);
}


static void
on_next (PatternDialog *pd)
{
  g_autoptr (GDBusConnection) bus = NULL;

  if (pd->stage == STAGE_DRAW) {
    g_strlcpy (pd->first, pd->seq, sizeof pd->first);
    set_stage (pd, STAGE_CONFIRM);
    return;
  }
  gtk_widget_set_sensitive (pd->next, FALSE);
  gtk_widget_set_sensitive (pd->cancel, FALSE);
  gtk_label_set_text (GTK_LABEL (pd->message), "Setting the pattern as your password…");
  bus = g_bus_get_sync (G_BUS_TYPE_SYSTEM, NULL, NULL);
  if (!bus) {
    gtk_label_set_text (GTK_LABEL (pd->message), "No system bus: the password was not changed.");
    gtk_widget_set_sensitive (pd->cancel, TRUE);
    return;
  }
  g_dbus_connection_call (bus, "org.freedesktop.Accounts", "/org/freedesktop/Accounts",
                          "org.freedesktop.Accounts", "FindUserById",
                          g_variant_new ("(x)", (gint64) getuid ()), G_VARIANT_TYPE ("(o)"),
                          G_DBUS_CALL_FLAGS_NONE, -1, NULL, on_user_found, pd);
}


static void
on_cancel (PatternDialog *pd)
{
  finish (pd, FALSE);
}


static void
on_closed (PatternDialog *pd)
{
  if (!pd->done && pd->callback)
    pd->callback (FALSE, pd->user_data);
  g_free (pd);
}


void
ms_pattern_dialog_present (GtkWidget *parent, MsPatternDone callback, gpointer user_data)
{
  PatternDialog *pd = g_new0 (PatternDialog, 1);
  GtkWidget *box, *buttons, *toolbar, *header;
  GtkGesture *drag;

  pd->callback = callback;
  pd->user_data = user_data;
  pd->dialog = ADW_DIALOG (adw_dialog_new ());
  /* floating, not a bottom sheet: a sheet is dragged down to close, the same stroke that draws a pattern */
  adw_dialog_set_presentation_mode (pd->dialog, ADW_DIALOG_FLOATING);
  adw_dialog_set_title (pd->dialog, "Set pattern");
  adw_dialog_set_content_width (pd->dialog, 360);
  adw_dialog_set_content_height (pd->dialog, 620);

  box = gtk_box_new (GTK_ORIENTATION_VERTICAL, 18);
  gtk_widget_set_margin_start (box, 18);
  gtk_widget_set_margin_end (box, 18);
  gtk_widget_set_margin_top (box, 12);
  gtk_widget_set_margin_bottom (box, 18);

  pd->message = gtk_label_new (NULL);
  gtk_label_set_wrap (GTK_LABEL (pd->message), TRUE);
  gtk_label_set_justify (GTK_LABEL (pd->message), GTK_JUSTIFY_CENTER);
  gtk_box_append (GTK_BOX (box), pd->message);

  pd->area = gtk_drawing_area_new ();
  gtk_widget_set_size_request (pd->area, 260, 260);
  gtk_widget_set_vexpand (pd->area, TRUE);
  gtk_drawing_area_set_draw_func (GTK_DRAWING_AREA (pd->area), draw_func, pd, NULL);
  drag = gtk_gesture_drag_new ();
  g_signal_connect (drag, "drag-begin", G_CALLBACK (on_drag_begin), pd);
  g_signal_connect (drag, "drag-update", G_CALLBACK (on_drag_update), pd);
  g_signal_connect (drag, "drag-end", G_CALLBACK (on_drag_end), pd);
  gtk_widget_add_controller (pd->area, GTK_EVENT_CONTROLLER (drag));
  gtk_box_append (GTK_BOX (box), pd->area);

  buttons = gtk_box_new (GTK_ORIENTATION_HORIZONTAL, 12);
  gtk_box_set_homogeneous (GTK_BOX (buttons), TRUE);
  pd->cancel = gtk_button_new_with_label ("Cancel");
  gtk_widget_add_css_class (pd->cancel, "pill");
  pd->next = gtk_button_new_with_label ("Continue");
  gtk_widget_add_css_class (pd->next, "pill");
  gtk_widget_add_css_class (pd->next, "suggested-action");
  g_signal_connect_swapped (pd->cancel, "clicked", G_CALLBACK (on_cancel), pd);
  g_signal_connect_swapped (pd->next, "clicked", G_CALLBACK (on_next), pd);
  gtk_box_append (GTK_BOX (buttons), pd->cancel);
  gtk_box_append (GTK_BOX (buttons), pd->next);
  gtk_box_append (GTK_BOX (box), buttons);

  toolbar = adw_toolbar_view_new ();
  header = adw_header_bar_new ();
  adw_toolbar_view_add_top_bar (ADW_TOOLBAR_VIEW (toolbar), header);
  adw_toolbar_view_set_content (ADW_TOOLBAR_VIEW (toolbar), box);
  adw_dialog_set_child (pd->dialog, toolbar);
  g_signal_connect_swapped (pd->dialog, "closed", G_CALLBACK (on_closed), pd);

  set_stage (pd, STAGE_DRAW);
  adw_dialog_present (pd->dialog, parent);
}

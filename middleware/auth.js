module.exports = {
  ensureAuthenticated: function(req, res, next) {
    if (req.session.user) {
      return next();
    }
    req.flash('error_msg', 'Please log in to view that resource');
    res.redirect('/login');
  },
  forwardAuthenticated: function(req, res, next) {
    if (!req.session.user) {
      return next();
    }
    res.redirect('/dashboard');      
  }
};

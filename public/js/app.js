// Dhyaan Realty - Frontend Interactions
document.addEventListener('DOMContentLoaded', () => {
    // Automatically dismiss flash messages after 5 seconds
    const alerts = document.querySelectorAll('.alert');
    if (alerts.length > 0) {
        setTimeout(() => {
            alerts.forEach(alert => {
                alert.style.transition = 'opacity 0.5s ease';
                alert.style.opacity = '0';
                setTimeout(() => alert.remove(), 500);
            });
        }, 5000);
    }

    // Add active state to sidebar links based on current URL
    const currentPath = window.location.pathname;
    const navLinks = document.querySelectorAll('.nav-links a');
    navLinks.forEach(link => {
        if (currentPath.startsWith(link.getAttribute('href'))) {
            // Avoid marking 'My Leads' active when on 'Dashboard' if URLs conflict,
            // but since they are distinct (/dashboard, /leads, /walkins), startsWith is okay.
            if (link.getAttribute('href') !== '/' || currentPath === '/') {
                 link.classList.add('active');
            }
        }
    });
});
